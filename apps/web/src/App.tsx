import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AppState,
  type BrokerDecision,
  type CalendarEvent,
  appStateSchema,
  demoSessionId,
  demoUserId,
  minutesBetween,
  primaryCalendarId,
} from '@build2026/shared';

const dayStartHour = 8;
const dayEndHour = 18;
const pixelsPerMinute = 1.45;
const snapMinutes = 15;

type DragState = {
  event: CalendarEvent;
  pointerOffsetMinutes: number;
  timelineTop: number;
  originalStartMinutes: number;
  durationMinutes: number;
  previewStart: string;
  previewEnd: string;
  moved: boolean;
};

type OptimisticMove = {
  start: string;
  end: string;
  createdAt: number;
  status: 'planning' | 'pending-confirmation';
};

type Toast = {
  id: number;
  message: string;
};

export function App() {
  const [state, setState] = useState<AppState | undefined>();
  const [selectedId, setSelectedId] = useState('focus-1');
  const [drag, setDrag] = useState<DragState | undefined>();
  const [optimisticMoves, setOptimisticMoves] = useState<Record<string, OptimisticMove>>({});
  const [toast, setToast] = useState<Toast | undefined>();
  const [agentSession, setAgentSession] = useState<unknown>();
  const dragRef = useRef<DragState | undefined>();
  const toastId = useRef(0);

  const displayedEvents = useMemo(
    () => state?.events.map((event) => optimisticMoves[event.id] ? { ...event, ...optimisticMoves[event.id] } : event) ?? [],
    [optimisticMoves, state],
  );
  const selectedEvent = useMemo(() => displayedEvents.find((event) => event.id === selectedId), [displayedEvents, selectedId]);
  const pendingDecisions = useMemo(
    () => state?.decisions.filter((decision) => decision.status === 'needs-confirmation') ?? [],
    [state],
  );
  const metrics = useMemo(() => {
    const decisions = state?.decisions ?? [];
    return {
      applied: decisions.filter((decision) => decision.status === 'applied').length,
      pending: decisions.filter((decision) => decision.status === 'needs-confirmation').length,
      rejected: decisions.filter((decision) => decision.status === 'rejected').length,
    };
  }, [state]);
  const isDragging = drag !== undefined;

  const showToast = useCallback((message: string) => {
    const id = ++toastId.current;
    setToast({ id, message });
    window.setTimeout(() => {
      setToast((current) => current?.id === id ? undefined : current);
    }, 3200);
  }, []);

  const setActiveDrag = useCallback((next: DragState | undefined) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  const loadState = useCallback(async () => {
    const next = appStateSchema.parse(await api('/api/state'));
    setState(next);
    if (!next.events.some((event) => event.id === selectedId)) {
      setSelectedId(next.events[0]?.id ?? '');
    }
  }, [selectedId]);

  useEffect(() => {
    void loadState();
    const events = new EventSource('/api/stream');
    events.addEventListener('state', (message) => {
      setState(appStateSchema.parse(JSON.parse((message as MessageEvent<string>).data)));
    });
    events.onerror = () => {
      events.close();
    };
    const interval = window.setInterval(() => void loadState(), 5000);
    return () => {
      events.close();
      window.clearInterval(interval);
    };
  }, [loadState]);

  useEffect(() => {
    if (!state) {
      return;
    }

    setOptimisticMoves((current) => {
      let changed = false;
      const next = { ...current };

      if (state.intents.length === 0 && state.decisions.length === 0) {
        return Object.keys(current).length === 0 ? current : {};
      }

      for (const [eventId, move] of Object.entries(current)) {
        const event = state.events.find((item) => item.id === eventId);
        if (!event || (event.start === move.start && event.end === move.end)) {
          delete next[eventId];
          changed = true;
          continue;
        }

        const decision = state.decisions.find((item) => item.eventId === eventId && Date.parse(item.createdAt) >= move.createdAt);
        if (decision?.status === 'rejected') {
          delete next[eventId];
          changed = true;
        } else if (decision?.status === 'needs-confirmation' && move.status !== 'pending-confirmation') {
          next[eventId] = { ...move, status: 'pending-confirmation' };
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [state]);

  useEffect(() => {
    if (!isDragging) {
      return;
    }

    const onMove = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) {
        return;
      }
      const rawStartMinutes =
        dayStartHour * 60 + (event.clientY - current.timelineTop) / pixelsPerMinute - current.pointerOffsetMinutes;
      const startMinutes = clamp(
        snap(rawStartMinutes),
        dayStartHour * 60,
        dayEndHour * 60 - current.durationMinutes,
      );
      const start = dateAtMinutes(current.event.start, startMinutes);
      const end = new Date(start.getTime() + current.durationMinutes * 60000);
      setActiveDrag({
        ...current,
        previewStart: start.toISOString(),
        previewEnd: end.toISOString(),
        moved: current.moved || startMinutes !== current.originalStartMinutes,
      });
    };

    const onUp = () => {
      const finalDrag = dragRef.current;
      setActiveDrag(undefined);
      if (!finalDrag) {
        return;
      }
      if (!finalDrag.moved) {
        return;
      }
      setOptimisticMoves((current) => ({
        ...current,
        [finalDrag.event.id]: {
          start: finalDrag.previewStart,
          end: finalDrag.previewEnd,
          createdAt: Date.now(),
          status: 'planning',
        },
      }));
      void createIntent(finalDrag.event, finalDrag.previewStart, finalDrag.previewEnd).catch((error: unknown) => {
        setOptimisticMoves((current) => {
          const next = { ...current };
          delete next[finalDrag.event.id];
          return next;
        });
        showToast(error instanceof Error ? error.message : 'Could not queue planning intent.');
      });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [isDragging, setActiveDrag, showToast]);

  async function createIntent(event: CalendarEvent, desiredStart: string, desiredEnd: string) {
    await api('/api/intents', {
      method: 'POST',
      body: JSON.stringify({
        userId: demoUserId,
        sessionId: demoSessionId,
        eventId: event.id,
        desiredStart,
        desiredEnd,
        source: 'drag',
      }),
    });
    showToast(`Planning intent queued for "${event.title}".`);
  }

  async function runCommand(path: string, label: string) {
    const result = await api(path, { method: 'POST' });
    if (path.includes('/reset') || path.includes('/clear-pending')) {
      setOptimisticMoves({});
    }
    showToast(label);
    if (path.includes('agent-session')) {
      setAgentSession(result);
    }
  }

  async function confirm(decision: BrokerDecision) {
    await api(`/api/proposals/${decision.proposalId}/patches/${decision.patchId}/confirm`, { method: 'POST' });
    showToast('Broker re-validated and applied the confirmed patch.');
  }

  async function reject(decision: BrokerDecision) {
    await api(`/api/proposals/${decision.proposalId}/patches/${decision.patchId}/reject`, { method: 'POST' });
    if (decision.eventId) {
      setOptimisticMoves((current) => {
        const next = { ...current };
        delete next[decision.eventId!];
        return next;
      });
    }
    showToast('Pending patch rejected.');
  }

  if (!state) {
    return <main className="loading">Loading calendar broker state...</main>;
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Build 2026 demo</p>
          <h1>Aspire with agents: a shared executable app model</h1>
          <p className="thesis">
            Drag the calendar like Figma for time. The planner can reason in the background, but the broker owns
            deterministic, auditable calendar writes.
          </p>
        </div>
        <div className="scoreboard" aria-label="Broker decisions">
          <Metric label="Applied" value={metrics.applied} tone="good" />
          <Metric label="Needs confirmation" value={metrics.pending} tone="hold" />
          <Metric label="Rejected" value={metrics.rejected} tone="bad" />
        </div>
      </section>

      <section className="workspace">
        <CalendarBoard
          events={displayedEvents}
          selectedId={selectedId}
          drag={drag}
          optimisticMoves={optimisticMoves}
          onSelect={setSelectedId}
          onDragStart={(event, pointerOffsetMinutes, timelineTop) => {
            setSelectedId(event.id);
            setActiveDrag({
              event,
              pointerOffsetMinutes,
              timelineTop,
              originalStartMinutes: minutesFromStart(event.start),
              durationMinutes: minutesBetween(event.start, event.end),
              previewStart: event.start,
              previewEnd: event.end,
              moved: false,
            });
          }}
        />

        <aside className="panel">
          <section className="card selected-card">
            <p className="eyebrow">Selected block</p>
            {selectedEvent ? (
              <>
                <h2>{selectedEvent.title}</h2>
                <p>{formatRange(selectedEvent.start, selectedEvent.end)}</p>
                <p className="muted">kind: {selectedEvent.kind} · etag: {selectedEvent.etag}</p>
                <div className="quick-actions">
                  <button onClick={() => void nudge(selectedEvent, -30)}>Earlier 30m</button>
                  <button onClick={() => void nudge(selectedEvent, 30)}>Later 30m</button>
                </div>
              </>
            ) : (
              <p>No event selected.</p>
            )}
          </section>

          <section className="card">
            <p className="eyebrow">Broker policy</p>
            <ul className="policy-list">
              <li>Owned focus/task/draft moves auto-apply with undo.</li>
              <li>Meetings, deletes, attendee/location/description edits require confirmation.</li>
              <li>Team calendars, non-owned events, and stale etags are rejected.</li>
            </ul>
          </section>

          <section className="card">
            <p className="eyebrow">Aspire resource commands</p>
            <div className="command-grid">
              <button onClick={() => void runCommand('/api/demo/reset', 'Calendar reset.')}>Reset user calendar</button>
              <button onClick={() => void runCommand('/api/demo/trigger-replanning', 'Replanning intent queued.')}>Trigger replanning</button>
              <button onClick={() => void runCommand('/api/demo/simulate-conflict', 'Stale etag conflict simulated.')}>Simulate conflict</button>
              <button onClick={() => void runCommand('/api/demo/replay-last-drag', 'Last drag replayed.')}>Replay last drag</button>
              <button onClick={() => void runCommand('/api/demo/clear-pending', 'Pending patches cleared.')}>Clear pending patches</button>
              <button onClick={() => void runCommand('/api/undo', 'Last applied patch undone.')}>Undo broker write</button>
              <button onClick={() => void runCommand('/api/demo/agent-session', 'Agent session inspected.')}>Inspect agent session</button>
            </div>
          </section>
        </aside>
      </section>

      <section className="lower-grid">
        <section className="card">
          <p className="eyebrow">Pending confirmations</p>
          {pendingDecisions.length === 0 ? (
            <p className="muted">Drag the meeting block to see a proposal held for confirmation.</p>
          ) : (
            pendingDecisions.map((decision) => (
              <div className="decision" key={decision.id}>
                <strong>{decision.policy}</strong>
                <p>{decision.reason}</p>
                <div>
                  <button onClick={() => void confirm(decision)}>Approve</button>
                  <button className="secondary" onClick={() => void reject(decision)}>Reject</button>
                </div>
              </div>
            ))
          )}
        </section>

        <section className="card">
          <p className="eyebrow">Audit trail</p>
          <div className="audit-list">
            {state.audit.slice(0, 9).map((entry) => (
              <div className="audit" key={entry.id}>
                <span>{formatClock(entry.at)}</span>
                <strong>{entry.actor}</strong>
                <p>{entry.message}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <p className="eyebrow">Agent runtime boundary</p>
          <p className="muted">
            ACA hosts stable services. Foundry hosted agents are modeled as planner execution sessions with per-user
            and per-chat isolation keys; they still cannot write the calendar directly.
          </p>
          <pre>{JSON.stringify(agentSession ?? latestAgentSession(state), null, 2)}</pre>
        </section>
      </section>

      {toast ? <div className="toast">{toast.message}</div> : null}
    </main>
  );

  async function nudge(event: CalendarEvent, minutes: number) {
    const start = new Date(Date.parse(event.start) + minutes * 60000);
    const end = new Date(Date.parse(event.end) + minutes * 60000);
    setOptimisticMoves((current) => ({
      ...current,
      [event.id]: {
        start: start.toISOString(),
        end: end.toISOString(),
        createdAt: Date.now(),
        status: 'planning',
      },
    }));
    await createIntent(event, start.toISOString(), end.toISOString());
  }
}

function CalendarBoard(props: {
  events: CalendarEvent[];
  selectedId: string;
  drag: DragState | undefined;
  optimisticMoves: Record<string, OptimisticMove>;
  onSelect: (eventId: string) => void;
  onDragStart: (event: CalendarEvent, pointerOffsetMinutes: number, timelineTop: number) => void;
}) {
  const sorted = [...props.events].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const previewEvent = props.drag
    ? { ...props.drag.event, start: props.drag.previewStart, end: props.drag.previewEnd }
    : undefined;

  return (
    <section className="calendar card">
      <div className="calendar-head">
        <div>
          <p className="eyebrow">Calendar planner</p>
          <h2>Drag blocks to create planning intents</h2>
        </div>
        <p className="muted">Primary calendar: {primaryCalendarId}</p>
      </div>
      <div className="timeline" style={{ height: (dayEndHour - dayStartHour) * 60 * pixelsPerMinute }}>
        {Array.from({ length: dayEndHour - dayStartHour + 1 }, (_, index) => dayStartHour + index).map((hour) => (
          <div className="hour-line" style={{ top: (hour - dayStartHour) * 60 * pixelsPerMinute }} key={hour}>
            <span>{formatHour(hour)}</span>
          </div>
        ))}
        {sorted.map((event) => (
          <EventBlock
            event={event.id === previewEvent?.id ? previewEvent : event}
            key={event.id}
            selected={props.selectedId === event.id}
            dragging={props.drag?.event.id === event.id}
            optimisticStatus={props.optimisticMoves[event.id]?.status}
            onSelect={() => props.onSelect(event.id)}
            onDragStart={(pointerOffsetMinutes, timelineTop) => props.onDragStart(event, pointerOffsetMinutes, timelineTop)}
          />
        ))}
      </div>
    </section>
  );
}

function EventBlock(props: {
  event: CalendarEvent;
  selected: boolean;
  dragging: boolean;
  optimisticStatus?: OptimisticMove['status'];
  onSelect: () => void;
  onDragStart: (pointerOffsetMinutes: number, timelineTop: number) => void;
}) {
  const top = (minutesFromStart(props.event.start) - dayStartHour * 60) * pixelsPerMinute;
  const height = Math.max(minutesBetween(props.event.start, props.event.end) * pixelsPerMinute, 42);
  return (
    <button
      className={`event ${props.event.kind} ${props.selected ? 'selected' : ''} ${props.dragging ? 'dragging' : ''} ${props.optimisticStatus ?? ''}`}
      style={{ top, height }}
      onClick={props.onSelect}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const eventRect = event.currentTarget.getBoundingClientRect();
        const timelineRect = event.currentTarget.closest('.timeline')?.getBoundingClientRect();
        props.onDragStart((event.clientY - eventRect.top) / pixelsPerMinute, timelineRect?.top ?? eventRect.top);
      }}
    >
      <strong>{props.event.title}</strong>
      <span>{formatRange(props.event.start, props.event.end)}</span>
      <small>
        {props.event.kind}
        {props.event.attendees.length ? ` · ${props.event.attendees.length} attendees` : ''}
        {props.optimisticStatus === 'planning' ? ' · planning' : ''}
        {props.optimisticStatus === 'pending-confirmation' ? ' · pending confirmation' : ''}
      </small>
    </button>
  );
}

function Metric(props: { label: string; value: number; tone: 'good' | 'hold' | 'bad' }) {
  return (
    <div className={`metric ${props.tone}`}>
      <strong>{props.value}</strong>
      <span>{props.label}</span>
    </div>
  );
}

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

function latestAgentSession(state: AppState): unknown {
  return state.proposals.find((proposal) => proposal.hostedAgentSession)?.hostedAgentSession ?? {
    runtime: 'local',
    note: 'Switch PLANNER_MODE=foundry-hosted in the AppHost to show the hosted-agent request shape.',
  };
}

function minutesFromStart(value: string): number {
  const date = new Date(value);
  return date.getHours() * 60 + date.getMinutes();
}

function dateAtMinutes(anchor: string, minutes: number): Date {
  const date = new Date(anchor);
  date.setHours(0, 0, 0, 0);
  date.setMinutes(minutes);
  return date;
}

function snap(value: number): number {
  return Math.round(value / snapMinutes) * snapMinutes;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatRange(start: string, end: string): string {
  return `${formatClock(start)} - ${formatClock(end)}`;
}

function formatClock(value: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function formatHour(hour: number): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric' }).format(new Date(2026, 5, 2, hour));
}
