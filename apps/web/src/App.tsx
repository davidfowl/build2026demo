import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, CheckCircle2, Clock3, ShieldCheck, XCircle } from 'lucide-react';
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

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const dayStartHour = 8;
const dayEndHour = 18;
const pixelsPerMinute = 1.16;
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

const eventKindStyles: Record<CalendarEvent['kind'], string> = {
  focus: 'border-l-blue-400 bg-blue-400/10 text-blue-50 hover:bg-blue-400/15',
  task: 'border-l-emerald-400 bg-emerald-400/10 text-emerald-50 hover:bg-emerald-400/15',
  draft: 'border-l-violet-400 bg-violet-400/10 text-violet-50 hover:bg-violet-400/15',
  meeting: 'border-l-amber-400 bg-amber-400/10 text-amber-50 hover:bg-amber-400/15',
  team: 'border-l-rose-400 bg-rose-400/10 text-rose-50 hover:bg-rose-400/15',
};

const optimisticStatusStyles: Record<OptimisticMove['status'], string> = {
  planning: 'outline outline-1 outline-offset-2 outline-blue-200/60',
  'pending-confirmation': 'outline outline-1 outline-offset-2 outline-amber-200/70',
};

export function App() {
  const [state, setState] = useState<AppState | undefined>();
  const [selectedId, setSelectedId] = useState('focus-1');
  const [drag, setDrag] = useState<DragState | undefined>();
  const [optimisticMoves, setOptimisticMoves] = useState<Record<string, OptimisticMove>>({});
  const [toast, setToast] = useState<Toast | undefined>();
  const dragRef = useRef<DragState | undefined>(undefined);
  const toastId = useRef(0);

  const displayedEvents = useMemo(
    () => state?.events.map((event) => (optimisticMoves[event.id] ? { ...event, ...optimisticMoves[event.id] } : event)) ?? [],
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
    return (
      <main className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Loading calendar broker state...
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-5 py-5">
      <section className="rounded-xl border border-border/70 bg-card/60 px-4 py-3 shadow-sm backdrop-blur">
        <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-center">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex size-9 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
              <ShieldCheck className="size-4" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">Calendar Operations</h1>
                <Badge variant="secondary">Broker enforced</Badge>
              </div>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                Coordinate planner proposals, confirmation queues, and auditable calendar writes from one workspace.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2" aria-label="Broker decisions">
            <Metric label="Applied" value={metrics.applied} tone="good" icon={<CheckCircle2 />} />
            <Metric label="Needs confirmation" value={metrics.pending} tone="hold" icon={<Clock3 />} />
            <Metric label="Rejected" value={metrics.rejected} tone="bad" icon={<XCircle />} />
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(680px,1fr)_340px]">
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

        <aside className="grid content-start gap-4">
          <Card className="border-border/70 bg-card/70 shadow-sm backdrop-blur">
            <CardHeader className="pb-2">
              <CardDescription>Selected block</CardDescription>
              {selectedEvent ? <CardTitle className="text-base">{selectedEvent.title}</CardTitle> : null}
            </CardHeader>
            <CardContent>
              {selectedEvent ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{selectedEvent.kind}</Badge>
                    <span className="text-sm text-muted-foreground">{formatRange(selectedEvent.start, selectedEvent.end)}</span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">etag {selectedEvent.etag}</p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => void nudge(selectedEvent, -30)}>
                      Earlier 30m
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => void nudge(selectedEvent, 30)}>
                      Later 30m
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No event selected.</p>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/70 bg-card/70 shadow-sm backdrop-blur">
            <CardHeader className="pb-2">
              <CardDescription>Broker policy</CardDescription>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="size-4 text-primary" />
                Safe writes only
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm leading-5 text-muted-foreground">
                <li>Owned focus, task, and draft moves auto-apply with undo.</li>
                <li>Meetings and attendee/location changes require confirmation.</li>
                <li>Team calendars, non-owned events, and stale etags are rejected.</li>
              </ul>
            </CardContent>
          </Card>
        </aside>
      </section>

      <section className="grid gap-4 xl:grid-cols-[0.9fr_1.2fr_1fr]">
        <Card className="border-border/70 bg-card/70 shadow-sm backdrop-blur">
          <CardHeader className="pb-2">
            <CardDescription>Pending confirmations</CardDescription>
            <CardTitle className="text-base">{pendingDecisions.length} held proposal{pendingDecisions.length === 1 ? '' : 's'}</CardTitle>
          </CardHeader>
          <CardContent>
            {pendingDecisions.length === 0 ? (
              <p className="text-sm text-muted-foreground">Drag the meeting block to see a proposal held for confirmation.</p>
            ) : (
              <div className="space-y-2">
                {pendingDecisions.map((decision) => (
                  <div className="rounded-lg border border-amber-400/20 bg-amber-400/10 p-3" key={decision.id}>
                    <div className="flex items-center justify-between gap-3">
                      <strong className="text-sm text-amber-100">{decision.policy}</strong>
                      <Badge variant="warning">needs review</Badge>
                    </div>
                    <p className="mt-2 text-sm leading-5 text-muted-foreground">{decision.reason}</p>
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" onClick={() => void confirm(decision)}>
                        Approve
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => void reject(decision)}>
                        Reject
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/70 shadow-sm backdrop-blur">
          <CardHeader className="pb-2">
            <CardDescription>Audit trail</CardDescription>
            <CardTitle className="text-base">Broker activity</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-h-72 space-y-2 overflow-auto pr-1">
              {state.audit.slice(0, 9).map((entry) => (
                <div className="grid grid-cols-[3.5rem_6rem_1fr] gap-3 rounded-lg border border-border/60 bg-background/35 p-2.5 text-sm" key={entry.id}>
                  <span className="text-xs text-muted-foreground">{formatClock(entry.at)}</span>
                  <strong className="truncate text-xs font-medium text-primary">{entry.actor}</strong>
                  <p className="m-0 leading-5 text-muted-foreground">{entry.message}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/70 shadow-sm backdrop-blur">
          <CardHeader className="pb-2">
            <CardDescription>Agent runtime boundary</CardDescription>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="size-4 text-primary" />
              Planner isolation
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-5 text-muted-foreground">
              ACA hosts stable services. Foundry hosted agents run as isolated planner sessions and still cannot write
              the calendar directly.
            </p>
            <pre className="mt-3 max-h-56 overflow-auto rounded-lg border border-border/60 bg-background/65 p-3 text-[11px] leading-5 text-muted-foreground">
              {JSON.stringify(latestAgentSession(state), null, 2)}
            </pre>
          </CardContent>
        </Card>
      </section>

      {toast ? (
        <div className="fixed bottom-5 right-5 max-w-md rounded-lg border border-emerald-400/25 bg-emerald-950/90 px-4 py-3 text-sm text-emerald-50 shadow-lg shadow-black/30 backdrop-blur">
          {toast.message}
        </div>
      ) : null}
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
    <Card className="overflow-hidden border-border/70 bg-card/70 shadow-sm backdrop-blur">
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div>
          <CardDescription>Calendar planner</CardDescription>
          <CardTitle className="text-base">Drag blocks to create planning intents</CardTitle>
        </div>
        <Badge variant="outline" className="hidden border-border/70 text-muted-foreground sm:inline-flex">
          {primaryCalendarId}
        </Badge>
      </CardHeader>
      <CardContent>
        <div
          className="relative overflow-hidden rounded-xl border border-border/60 bg-background/55"
          data-timeline
          style={{
            height: (dayEndHour - dayStartHour) * 60 * pixelsPerMinute,
            backgroundImage: 'linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px)',
            backgroundPosition: '72px 0',
            backgroundSize: 'calc((100% - 72px) / 5) 100%',
          }}
        >
          {Array.from({ length: dayEndHour - dayStartHour + 1 }, (_, index) => dayStartHour + index).map((hour) => (
            <div
              className="absolute left-0 right-0 h-px bg-border/45"
              style={{ top: (hour - dayStartHour) * 60 * pixelsPerMinute }}
              key={hour}
            >
              <span className="absolute left-3 top-[-0.55rem] text-[11px] font-medium text-muted-foreground">
                {formatHour(hour)}
              </span>
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
      </CardContent>
    </Card>
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
  const height = Math.max(minutesBetween(props.event.start, props.event.end) * pixelsPerMinute, 36);

  return (
    <button
      type="button"
      className={cn(
        'absolute left-[78px] flex w-[calc(100%-94px)] touch-none select-none flex-col items-start justify-center overflow-hidden rounded-lg border border-l-4 px-3 py-2 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        eventKindStyles[props.event.kind],
        props.selected && 'ring-2 ring-ring/70',
        props.dragging && 'z-10 opacity-85 shadow-lg',
        props.optimisticStatus && optimisticStatusStyles[props.optimisticStatus],
      )}
      style={{ top, height }}
      onClick={props.onSelect}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const eventRect = event.currentTarget.getBoundingClientRect();
        const timelineRect = event.currentTarget.closest('[data-timeline]')?.getBoundingClientRect();
        props.onDragStart((event.clientY - eventRect.top) / pixelsPerMinute, timelineRect?.top ?? eventRect.top);
      }}
    >
      <strong className="truncate text-sm font-semibold">{props.event.title}</strong>
      <span className="truncate text-xs text-current/70">{formatRange(props.event.start, props.event.end)}</span>
      <small className="truncate text-[11px] text-current/60">
        {props.event.kind}
        {props.event.attendees.length ? ` - ${props.event.attendees.length} attendees` : ''}
        {props.optimisticStatus === 'planning' ? ' - planning' : ''}
        {props.optimisticStatus === 'pending-confirmation' ? ' - pending confirmation' : ''}
      </small>
    </button>
  );
}

function Metric(props: { label: string; value: number; tone: 'good' | 'hold' | 'bad'; icon: React.ReactNode }) {
  const toneClass = {
    good: 'text-emerald-300',
    hold: 'text-amber-300',
    bad: 'text-rose-300',
  }[props.tone];

  return (
    <Card className="min-w-28 border-border/70 bg-card/70 p-3 shadow-sm backdrop-blur">
      <div className={cn('mb-2 flex items-center justify-between', toneClass)}>
        {props.icon}
        <strong className="text-2xl font-semibold leading-none">{props.value}</strong>
      </div>
      <span className="block text-xs leading-4 text-muted-foreground">{props.label}</span>
    </Card>
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
