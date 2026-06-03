import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, CalendarPlus, CheckCircle2, Clock3, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import {
  type AppState,
  type BookMeetingRequest,
  type BrokerDecision,
  type CalendarEvent,
  type MeetingReadinessJob,
  type ReadinessSuggestion,
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
const demoWeekStartIso = '2026-06-02T09:00:00-07:00';
const startTimeOptions = Array.from(
  { length: Math.floor(((dayEndHour - dayStartHour) * 60 - 30) / snapMinutes) + 1 },
  (_, index) => timeFromMinutes(dayStartHour * 60 + index * snapMinutes),
);
const durationOptions = [30, 45, 60, 90];
const inputClassName = 'mt-1 w-full rounded-md border border-border/60 bg-background/65 px-2.5 py-2 text-sm text-foreground shadow-sm outline-none transition placeholder:text-muted-foreground focus:border-primary/60 focus:ring-2 focus:ring-primary/20';

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

type NewMeetingForm = {
  title: string;
  dateKey: string;
  startTime: string;
  durationMinutes: number;
  location: string;
  attendees: string;
  description: string;
};

type BookMeetingResponse = {
  event: CalendarEvent;
  decision: BrokerDecision;
  job: MeetingReadinessJob;
};

type DraftSelection = {
  startMinutes: number;
  endMinutes: number;
  moved: boolean;
};

const eventKindStyles: Record<CalendarEvent['kind'], string> = {
  focus: 'border-l-blue-400 bg-blue-400/10 text-blue-50 hover:bg-blue-400/15',
  task: 'border-l-emerald-400 bg-emerald-400/10 text-emerald-50 hover:bg-emerald-400/15',
  draft: 'border-l-violet-400 bg-violet-400/10 text-violet-50 hover:bg-violet-400/15',
  meeting: 'border-l-amber-400 bg-amber-400/10 text-amber-50 hover:bg-amber-400/15',
  team: 'border-l-rose-400 bg-rose-400/10 text-rose-50 hover:bg-rose-400/15',
  prep: 'border-l-cyan-300 bg-cyan-300/10 text-cyan-50 hover:bg-cyan-300/15',
};

const optimisticStatusStyles: Record<OptimisticMove['status'], string> = {
  planning: 'outline outline-1 outline-offset-2 outline-blue-200/60',
  'pending-confirmation': 'outline outline-1 outline-offset-2 outline-amber-200/70',
};

export function App() {
  const [state, setState] = useState<AppState | undefined>();
  const [selectedId, setSelectedId] = useState('');
  const [selectedDateKey, setSelectedDateKey] = useState<string | undefined>();
  const [draftPlaced, setDraftPlaced] = useState(false);
  const [drag, setDrag] = useState<DragState | undefined>();
  const [optimisticMoves, setOptimisticMoves] = useState<Record<string, OptimisticMove>>({});
  const [newMeeting, setNewMeeting] = useState<NewMeetingForm>(() => ({
    title: 'Build keynote readiness review',
    dateKey: '',
    startTime: '14:00',
    durationMinutes: 60,
    location: 'Microsoft Reactor - Seattle',
    attendees: 'nikki@example.com, scott@example.com',
    description: 'Review Build demo goals, agent readiness, and broker-safe calendar changes.',
  }));
  const [bookingMeeting, setBookingMeeting] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<CalendarEvent | undefined>();
  const [deletingEvent, setDeletingEvent] = useState(false);
  const [toast, setToast] = useState<Toast | undefined>();
  const dragRef = useRef<DragState | undefined>(undefined);
  const toastId = useRef(0);

  const displayedEvents = useMemo(
    () => state?.events.map((event) => (optimisticMoves[event.id] ? { ...event, ...optimisticMoves[event.id] } : event)) ?? [],
    [optimisticMoves, state],
  );
  const selectedEvent = useMemo(() => displayedEvents.find((event) => event.id === selectedId), [displayedEvents, selectedId]);
  const weekDays = useMemo(() => buildWeekDays(state?.events ?? []), [state]);
  const selectedDate = selectedDateKey
    ?? (selectedEvent ? dateKey(selectedEvent.start) : (weekDays[0]?.key ?? dateKey(demoWeekStartIso)));
  const visibleEvents = useMemo(
    () => displayedEvents.filter((event) => dateKey(event.start) === selectedDate),
    [displayedEvents, selectedDate],
  );
  const draftMeeting = useMemo(() => createDraftMeeting(newMeeting, selectedDate), [newMeeting, selectedDate]);
  const draftHasConflict = useMemo(
    () => displayedEvents.some((event) => dateKey(event.start) === dateKey(draftMeeting.start) && eventsOverlap(event, draftMeeting)),
    [displayedEvents, draftMeeting],
  );
  const selectedReadinessJob = useMemo(
    () => selectedEvent ? state?.readinessJobs.find((job) => job.meetingId === selectedEvent.id) : undefined,
    [selectedEvent, state],
  );
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
    setSelectedId((current) => current && !next.events.some((event) => event.id === current) ? '' : current);
  }, []);

  useEffect(() => {
    if (!state || selectedDateKey) {
      return;
    }

    const anchor = state.events.find((event) => event.id === selectedId) ?? state.events[0];
    if (anchor) {
      setSelectedDateKey(dateKey(anchor.start));
    }
  }, [selectedDateKey, selectedId, state]);

  useEffect(() => {
    if (!state || !selectedId || state.events.some((event) => event.id === selectedId)) {
      return;
    }
    setSelectedId('');
    setDraftPlaced(false);
  }, [selectedId, state]);

  useEffect(() => {
    setNewMeeting((current) => current.dateKey === selectedDate ? current : { ...current, dateKey: selectedDate });
  }, [selectedDate]);

  useEffect(() => {
    if (selectedEvent) {
      setSelectedDateKey(dateKey(selectedEvent.start));
    }
  }, [selectedEvent]);

  useEffect(() => {
    if (!draftPlaced || deleteCandidate) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDraftPlaced(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteCandidate, draftPlaced]);

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

  async function startReadiness(event: CalendarEvent) {
    await api(`/api/meetings/${event.id}/readiness`, {
      method: 'POST',
      body: JSON.stringify({
        userId: demoUserId,
        sessionId: demoSessionId,
      }),
    });
    showToast(`Meeting readiness agent queued for "${event.title}".`);
  }

  async function acceptReadinessSuggestion(job: MeetingReadinessJob, suggestion: ReadinessSuggestion) {
    const result = await api(`/api/readiness-jobs/${job.id}/suggestions/${suggestion.id}/accept`, { method: 'POST' }) as { decision?: BrokerDecision };
    showToast(result.decision?.status === 'applied'
      ? 'Broker validated and added the suggested calendar block.'
      : 'Broker reviewed the readiness suggestion.');
  }

  async function requestDelete(event: CalendarEvent) {
    setDeletingEvent(true);
    try {
      const result = await api(`/api/events/${event.id}/delete`, {
        method: 'POST',
        body: JSON.stringify({
          userId: demoUserId,
          sessionId: demoSessionId,
          confirmed: true,
        }),
      }) as { decision?: BrokerDecision };
      if (result.decision?.status === 'applied') {
        setDeleteCandidate(undefined);
        setSelectedId((current) => current === event.id ? '' : current);
        setDraftPlaced(false);
        showToast(`Deleted "${event.title}".`);
        return;
      }
      setDeleteCandidate(undefined);
      showToast(result.decision?.status === 'needs-confirmation'
        ? `Delete request for "${event.title}" is waiting for confirmation.`
        : `Broker reviewed delete request for "${event.title}".`);
    } catch (error) {
      setDeleteCandidate(undefined);
      showToast(error instanceof Error ? error.message : `Could not delete "${event.title}".`);
    } finally {
      setDeletingEvent(false);
    }
  }

  async function bookMeeting() {
    const title = newMeeting.title.trim();
    if (!title) {
      showToast('Add a meeting title before booking.');
      return;
    }

    const start = dateTimeFromFields(newMeeting.dateKey || selectedDate, newMeeting.startTime);
    const end = new Date(start.getTime() + newMeeting.durationMinutes * 60000);
    if (state && hasCalendarConflict(state.events, start.toISOString(), end.toISOString())) {
      setDraftPlaced(false);
      setSelectedId('');
      showToast('Drag across an open slot for the draft meeting.');
      return;
    }

    const body: BookMeetingRequest = {
      userId: demoUserId,
      sessionId: demoSessionId,
      title,
      start: start.toISOString(),
      end: end.toISOString(),
      attendees: parseAttendees(newMeeting.attendees),
      ...(newMeeting.location.trim() ? { location: newMeeting.location.trim() } : {}),
      ...(newMeeting.description.trim() ? { description: newMeeting.description.trim() } : {}),
    };

    setBookingMeeting(true);
    try {
      const result = await api('/api/meetings', {
        method: 'POST',
        body: JSON.stringify(body),
      }) as BookMeetingResponse;
      const bookedDay = dateKey(result.event.start);
      const nextStartTime = findOpenStartTime(
        [...(state?.events ?? []), result.event],
        bookedDay,
        newMeeting.durationMinutes,
        minutesFromStart(result.event.end),
      );
      setSelectedId(result.event.id);
      setSelectedDateKey(bookedDay);
      setNewMeeting((current) => ({
        ...current,
        title: '',
        dateKey: bookedDay,
        startTime: nextStartTime,
      }));
      setDraftPlaced(false);
      showToast(`Broker booked "${result.event.title}" and queued readiness analysis.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not book meeting.');
    } finally {
      setBookingMeeting(false);
    }
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
                Book a meeting, let the readiness agent run tools, then accept useful suggestions through the broker.
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

      <section className="grid gap-4 xl:grid-cols-[minmax(680px,1fr)_380px]">
        <CalendarBoard
          events={visibleEvents}
          visibleDate={selectedDate}
          selectedId={selectedId}
          drag={drag}
          optimisticMoves={optimisticMoves}
          onSelect={(eventId) => {
            setSelectedId(eventId);
            setDraftPlaced(false);
          }}
          days={weekDays}
          onSelectDay={(day) => {
            setSelectedDateKey(day);
            setNewMeeting((current) => ({
              ...current,
              dateKey: day,
              startTime: findOpenStartTime(displayedEvents, day, current.durationMinutes, minutesFromTime(current.startTime)),
            }));
            setSelectedId('');
            setDraftPlaced(false);
          }}
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
          draftMeeting={draftMeeting}
          showDraft={draftPlaced}
          draftHasConflict={draftHasConflict}
          draftBusy={bookingMeeting}
          onDraftSlotChange={(startTime, durationMinutes) => {
            setSelectedId('');
            setDraftPlaced(true);
            setNewMeeting((current) => ({ ...current, dateKey: selectedDate, startTime, durationMinutes }));
          }}
          onDraftMove={(startTime) => {
            setSelectedId('');
            setNewMeeting((current) => ({ ...current, dateKey: selectedDate, startTime }));
          }}
          onDismissDraft={() => setDraftPlaced(false)}
          onBlockedSlot={() => {
            setSelectedId('');
            setDraftPlaced(false);
            showToast('Drag across an open slot for the draft meeting.');
          }}
          onBookDraft={() => void bookMeeting()}
          onDelete={setDeleteCandidate}
        />

        <aside className="grid content-start gap-4">
          <NewMeetingCard
            form={newMeeting}
            days={weekDays}
            selectedDate={selectedDate}
            busy={bookingMeeting}
            draftHasConflict={draftHasConflict}
            draftPlaced={draftPlaced}
            onChange={(patch) => {
              setNewMeeting((current) => {
                const next = { ...current, ...patch };
                if (patch.dateKey) {
                  next.startTime = findOpenStartTime(
                    displayedEvents,
                    patch.dateKey,
                    next.durationMinutes,
                    minutesFromTime(next.startTime),
                  );
                }
                return next;
              });
              setSelectedId('');
              if (patch.dateKey) {
                setSelectedDateKey(patch.dateKey);
              }
            }}
            onSubmit={() => void bookMeeting()}
          />

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
                  {selectedEvent.location ? (
                    <p className="text-sm text-muted-foreground">{selectedEvent.location}</p>
                  ) : null}
                  <p className="truncate text-xs text-muted-foreground">etag {selectedEvent.etag}</p>
                  <div className="flex flex-wrap gap-2">
                    {selectedEvent.kind === 'meeting' ? (
                      <Button
                        size="sm"
                        onClick={() => void startReadiness(selectedEvent)}
                        disabled={selectedReadinessJob?.status === 'queued' || selectedReadinessJob?.status === 'running'}
                      >
                        {selectedReadinessJob?.status === 'queued' || selectedReadinessJob?.status === 'running'
                          ? 'Readiness running'
                          : 'Run readiness agent'}
                      </Button>
                    ) : null}
                    <Button size="sm" variant="secondary" onClick={() => void nudge(selectedEvent, -30)}>
                      Earlier 30m
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => void nudge(selectedEvent, 30)}>
                      Later 30m
                    </Button>
                    {selectedEvent.kind === 'meeting' ? (
                      <Button size="sm" variant="destructive" onClick={() => setDeleteCandidate(selectedEvent)}>
                        Delete
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No event selected.</p>
              )}
            </CardContent>
          </Card>

          <ReadinessPanel
            event={selectedEvent}
            job={selectedReadinessJob}
            decisions={state.decisions}
            onStart={(event) => void startReadiness(event)}
            onAccept={(job, suggestion) => void acceptReadinessSuggestion(job, suggestion)}
          />

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
                <li>Meeting moves, deletes, and attendee/location changes require confirmation.</li>
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
              <p className="text-sm text-muted-foreground">Use Earlier/Later on a meeting with attendees to see a held proposal; deletes use the trash modal.</p>
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

      {deleteCandidate ? (
        <DeleteConfirmationModal
          event={deleteCandidate}
          busy={deletingEvent}
          onCancel={() => setDeleteCandidate(undefined)}
          onConfirm={() => void requestDelete(deleteCandidate)}
        />
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

function NewMeetingCard(props: {
  form: NewMeetingForm;
  days: Array<{ key: string; label: string; subtitle: string; count: number }>;
  selectedDate: string;
  busy: boolean;
  draftHasConflict: boolean;
  draftPlaced: boolean;
  onChange: (patch: Partial<NewMeetingForm>) => void;
  onSubmit: () => void;
}) {
  const formDate = props.form.dateKey || props.selectedDate;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    props.onSubmit();
  }

  return (
    <Card className="border-border/70 bg-card/70 shadow-sm backdrop-blur">
      <CardHeader className="pb-2">
        <CardDescription>New meeting</CardDescription>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarPlus className="size-4 text-primary" />
          Book and analyze
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-3" onSubmit={submit}>
          <label className="block text-xs font-medium text-muted-foreground">
            Title
            <input
              className={inputClassName}
              value={props.form.title}
              onChange={(event) => props.onChange({ title: event.target.value })}
              placeholder="Build keynote readiness review"
              required
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs font-medium text-muted-foreground">
              Day
              <select
                className={inputClassName}
                value={formDate}
                onChange={(event) => props.onChange({ dateKey: event.target.value })}
              >
                {props.days.map((day) => (
                  <option value={day.key} key={day.key}>
                    {day.label} {day.subtitle}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-medium text-muted-foreground">
              Start
              <select
                className={inputClassName}
                value={props.form.startTime}
                onChange={(event) => props.onChange({ startTime: event.target.value })}
              >
                {startTimeOptions.map((time) => (
                  <option value={time} key={time}>
                    {time}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs font-medium text-muted-foreground">
              Duration
              <select
                className={inputClassName}
                value={props.form.durationMinutes}
                onChange={(event) => props.onChange({ durationMinutes: Number(event.target.value) })}
              >
                {durationOptions.map((duration) => (
                  <option value={duration} key={duration}>
                    {duration} min
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-medium text-muted-foreground">
              Location
              <input
                className={inputClassName}
                value={props.form.location}
                onChange={(event) => props.onChange({ location: event.target.value })}
                placeholder="Teams or Seattle"
              />
            </label>
          </div>

          <label className="block text-xs font-medium text-muted-foreground">
            Attendees
            <input
              className={inputClassName}
              value={props.form.attendees}
              onChange={(event) => props.onChange({ attendees: event.target.value })}
              placeholder="nikki@example.com, scott@example.com"
            />
          </label>

          <label className="block text-xs font-medium text-muted-foreground">
            Agenda notes
            <textarea
              className={cn(inputClassName, 'min-h-20 resize-none')}
              value={props.form.description}
              onChange={(event) => props.onChange({ description: event.target.value })}
              placeholder="What should the agent prepare for?"
            />
          </label>

          <Button className="w-full" type="submit" disabled={props.busy || props.draftHasConflict}>
            {props.busy ? 'Booking...' : 'Book meeting + run analysis'}
          </Button>
          <p className="text-xs leading-5 text-muted-foreground">
            {props.draftHasConflict
              ? 'That draft overlaps an existing meeting. Drag across an open slot before booking.'
              : props.draftPlaced
                ? 'Drag the draft to move it, use the trash button to discard it, or press Escape.'
                : 'Drag across an open time range on the calendar to place a draft.'}
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

function CalendarBoard(props: {
  events: CalendarEvent[];
  visibleDate: string;
  days: Array<{ key: string; label: string; subtitle: string; count: number }>;
  selectedId: string;
  drag: DragState | undefined;
  optimisticMoves: Record<string, OptimisticMove>;
  draftMeeting: CalendarEvent;
  showDraft: boolean;
  draftHasConflict: boolean;
  draftBusy: boolean;
  onSelect: (eventId: string) => void;
  onSelectDay: (day: string) => void;
  onDragStart: (event: CalendarEvent, pointerOffsetMinutes: number, timelineTop: number) => void;
  onDraftSlotChange: (startTime: string, durationMinutes: number) => void;
  onDraftMove: (startTime: string) => void;
  onDismissDraft: () => void;
  onBlockedSlot: () => void;
  onBookDraft: () => void;
  onDelete: (event: CalendarEvent) => void;
}) {
  const [selection, setSelection] = useState<DraftSelection | undefined>();
  const sorted = [...props.events].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const previewEvent = props.drag
    ? { ...props.drag.event, start: props.drag.previewStart, end: props.drag.previewEnd }
    : undefined;
  const selectionEvent = selection
    ? {
      ...props.draftMeeting,
      start: dateTimeFromFields(props.visibleDate, timeFromMinutes(selection.startMinutes)).toISOString(),
      end: dateTimeFromFields(props.visibleDate, timeFromMinutes(selection.endMinutes)).toISOString(),
    }
    : undefined;
  const selectionHasConflict = selection
    ? !isOpenSlot(props.events, selection.startMinutes, selection.endMinutes)
    : false;

  return (
    <Card className="overflow-hidden border-border/70 bg-card/70 shadow-sm backdrop-blur">
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div>
          <CardDescription>7-day calendar</CardDescription>
          <CardTitle className="text-base">Book a meeting or inspect an existing one</CardTitle>
        </div>
        <Badge variant="outline" className="hidden border-border/70 text-muted-foreground sm:inline-flex">
          {primaryCalendarId}
        </Badge>
      </CardHeader>
      <CardContent>
        <div className="mb-3 grid grid-cols-7 gap-2">
          {props.days.map((day) => (
            <button
              type="button"
              className={cn(
                'rounded-lg border border-border/60 bg-background/35 px-2 py-2 text-left transition hover:border-primary/40 hover:bg-primary/10',
                props.visibleDate === day.key && 'border-primary/60 bg-primary/15 text-primary',
              )}
              onClick={() => props.onSelectDay(day.key)}
              key={day.key}
            >
              <span className="block text-xs font-medium">{day.label}</span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">{day.subtitle}</span>
              <span className="mt-1 block text-[11px] text-muted-foreground">{day.count} item{day.count === 1 ? '' : 's'}</span>
            </button>
          ))}
        </div>
        <div
          className="relative overflow-hidden rounded-xl border border-border/60 bg-background/55"
          data-timeline
          style={{
            height: (dayEndHour - dayStartHour) * 60 * pixelsPerMinute,
            backgroundImage: 'linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px)',
            backgroundPosition: '72px 0',
            backgroundSize: 'calc((100% - 72px) / 5) 100%',
          }}
          onPointerDown={(event) => {
            const target = event.target as HTMLElement;
            if (target.closest('[data-event-block], [data-draft-meeting], button')) {
              return;
            }
            if (event.button !== 0) {
              return;
            }
            const rect = event.currentTarget.getBoundingClientRect();
            const anchorMinutes = pointerMinutes(event.clientY, rect.top);
            let latest = normalizeDraftSelection(anchorMinutes, anchorMinutes);
            let moved = false;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);

            const onMove = (moveEvent: PointerEvent) => {
              moved = moved || Math.abs(moveEvent.clientY - event.clientY) > 4;
              latest = {
                ...normalizeDraftSelection(anchorMinutes, pointerMinutes(moveEvent.clientY, rect.top)),
                moved,
              };
              if (latest.moved) {
                setSelection(latest);
              }
            };
            const onUp = () => {
              window.removeEventListener('pointermove', onMove);
              window.removeEventListener('pointerup', onUp);
              setSelection(undefined);
              if (!latest.moved) {
                return;
              }
              if (!isOpenSlot(props.events, latest.startMinutes, latest.endMinutes)) {
                props.onBlockedSlot();
                return;
              }
              props.onDraftSlotChange(
                timeFromMinutes(latest.startMinutes),
                latest.endMinutes - latest.startMinutes,
              );
            };

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp, { once: true });
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
              onDelete={() => props.onDelete(event)}
            />
          ))}
          {selectionEvent ? (
            <DraftMeetingBlock
              event={selectionEvent}
              busy={props.draftBusy}
              hasConflict={selectionHasConflict}
              previewOnly
              onBook={props.onBookDraft}
            />
          ) : null}
          {!selectionEvent && props.showDraft ? (
            <DraftMeetingBlock
              event={props.draftMeeting}
              busy={props.draftBusy}
              hasConflict={props.draftHasConflict}
              onMove={(startTime) => {
                if (!isOpenSlotForDraft(props.events, props.draftMeeting, startTime, props.visibleDate)) {
                  props.onBlockedSlot();
                  return;
                }
                props.onDraftMove(startTime);
              }}
              onDismiss={props.onDismissDraft}
              onBook={props.onBookDraft}
            />
          ) : null}
          {sorted.length === 0 && !props.showDraft && !selectionEvent ? (
            <div className="pointer-events-none absolute inset-x-20 top-16 rounded-lg border border-dashed border-border/70 bg-background/45 p-4 text-sm text-muted-foreground">
              No booked calendar blocks on this day. Drag across the timeline to place a draft meeting.
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function ReadinessPanel(props: {
  event: CalendarEvent | undefined;
  job: MeetingReadinessJob | undefined;
  decisions: BrokerDecision[];
  onStart: (event: CalendarEvent) => void;
  onAccept: (job: MeetingReadinessJob, suggestion: ReadinessSuggestion) => void;
}) {
  const event = props.event;
  const job = props.job;

  return (
    <Card className="border-border/70 bg-card/70 shadow-sm backdrop-blur">
      <CardHeader className="pb-2">
        <CardDescription>Meeting readiness</CardDescription>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="size-4 text-primary" />
          Long-running agent job
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!event || event.kind !== 'meeting' ? (
          <p className="text-sm leading-5 text-muted-foreground">Select a meeting to run prep, weather, travel, and materials analysis.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge
                variant={job?.status === 'completed'
                  ? 'success'
                  : job?.status === 'failed'
                    ? 'destructive'
                    : job?.status === 'canceled'
                      ? 'warning'
                      : 'secondary'}
              >
                {job?.status ?? 'not started'}
              </Badge>
              <Button
                size="sm"
                variant={job?.status === 'queued' || job?.status === 'running' ? 'secondary' : 'default'}
                disabled={job?.status === 'queued' || job?.status === 'running'}
                onClick={() => props.onStart(event)}
              >
                {job?.status === 'queued' || job?.status === 'running' ? 'Running tools' : 'Find prep time'}
              </Button>
            </div>

            {job?.currentStep ? (
              <div className="rounded-lg border border-primary/20 bg-primary/10 p-3 text-sm">
                <strong className="text-primary">{job.currentStep}</strong>
                {job.status === 'failed' && job.error ? (
                  <p className="mt-1 text-muted-foreground">{job.error}</p>
                ) : null}
              </div>
            ) : null}

            {job && job.completedSteps.length > 0 ? (
              <div className="space-y-1.5">
                {job.completedSteps.map((step) => (
                  <div className="rounded-md border border-border/60 bg-background/35 px-2.5 py-2 text-xs" key={step.id}>
                    <strong className="text-foreground">{step.label}</strong>
                    <p className="mt-0.5 text-muted-foreground">{step.detail}</p>
                  </div>
                ))}
              </div>
            ) : null}

            {job && job.suggestions.length > 0 ? (
              <div className="space-y-2">
                {job.suggestions.map((suggestion) => {
                  const decision = suggestion.decisionId
                    ? props.decisions.find((item) => item.id === suggestion.decisionId)
                    : undefined;
                  return (
                    <div className="rounded-lg border border-border/60 bg-background/40 p-3" key={suggestion.id}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <Badge variant="outline" className="mb-2 border-border/70 text-muted-foreground">
                            {suggestionKindLabel(suggestion.kind)}
                          </Badge>
                          <strong className="block text-sm text-foreground">{suggestion.title}</strong>
                        </div>
                        {decision ? <Badge variant={decision.status === 'applied' ? 'success' : 'warning'}>{decision.status}</Badge> : null}
                      </div>
                      <p className="mt-2 text-sm leading-5 text-muted-foreground">{suggestion.detail}</p>
                      {suggestion.rationale ? (
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">{suggestion.rationale}</p>
                      ) : null}
                      {suggestion.proposedPatch && !decision ? (
                        <Button className="mt-3" size="sm" onClick={() => props.onAccept(job, suggestion)}>
                          Add to calendar
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        )}
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
  onDelete: () => void;
}) {
  const top = (minutesFromStart(props.event.start) - dayStartHour * 60) * pixelsPerMinute;
  const height = Math.max(minutesBetween(props.event.start, props.event.end) * pixelsPerMinute, 36);

  return (
    <div
      data-event-block
      role="group"
      aria-label={`${props.event.title}, ${formatRange(props.event.start, props.event.end)}`}
      tabIndex={0}
      className={cn(
        'group absolute left-[78px] flex w-[calc(100%-94px)] touch-none select-none flex-col items-start justify-center overflow-hidden rounded-lg border border-l-4 px-3 py-2 pr-10 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        eventKindStyles[props.event.kind],
        props.selected && 'ring-2 ring-ring/70',
        props.dragging && 'z-10 opacity-85 shadow-lg',
        props.optimisticStatus && optimisticStatusStyles[props.optimisticStatus],
      )}
      style={{ top, height }}
      onClick={(event) => {
        event.stopPropagation();
        props.onSelect();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          props.onSelect();
        }
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
      {props.event.kind === 'meeting' ? (
        <button
          type="button"
          className="absolute right-1.5 top-1.5 inline-flex size-7 items-center justify-center rounded-md border border-rose-300/30 bg-rose-950/70 text-rose-100 opacity-0 shadow-sm transition hover:bg-rose-900 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-200/70 group-hover:opacity-100"
          aria-label={`Request delete for ${props.event.title}`}
          title="Request delete"
          onClick={(event) => {
            event.stopPropagation();
            props.onDelete();
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Trash2 className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function DraftMeetingBlock(props: {
  event: CalendarEvent;
  busy: boolean;
  hasConflict: boolean;
  previewOnly?: boolean;
  onMove?: (startTime: string) => void;
  onDismiss?: () => void;
  onBook: () => void;
}) {
  const height = Math.max(minutesBetween(props.event.start, props.event.end) * pixelsPerMinute, 48);
  const duration = minutesBetween(props.event.start, props.event.end);
  const [previewStartTime, setPreviewStartTime] = useState<string | undefined>();
  const displayEvent = previewStartTime
    ? {
      ...props.event,
      start: dateTimeFromFields(dateKey(props.event.start), previewStartTime).toISOString(),
      end: dateAtMinutes(props.event.start, minutesFromTime(previewStartTime) + duration).toISOString(),
    }
    : props.event;
  const displayTop = (minutesFromStart(displayEvent.start) - dayStartHour * 60) * pixelsPerMinute;

  return (
    <div
      data-draft-meeting
      className={cn(
        'absolute left-[78px] z-[1] flex w-[calc(100%-94px)] touch-none select-none flex-col justify-center rounded-lg border border-dashed px-3 py-2 pr-28 text-left shadow-sm ring-1',
        !props.previewOnly && 'cursor-grab active:cursor-grabbing',
        props.hasConflict
          ? 'border-rose-200/75 bg-rose-500/15 text-rose-50 ring-rose-200/25'
          : 'border-amber-200/70 bg-amber-300/15 text-amber-50 ring-amber-200/25',
      )}
      style={{ top: displayTop, height }}
      onPointerDown={(event) => {
        if (props.previewOnly || !props.onMove || props.busy) {
          return;
        }
        const target = event.target as HTMLElement;
        if (target.closest('button')) {
          return;
        }
        const timeline = event.currentTarget.closest('[data-timeline]');
        if (!(timeline instanceof HTMLElement)) {
          return;
        }
        const rect = timeline.getBoundingClientRect();
        const pointerOffsetMinutes = (event.clientY - event.currentTarget.getBoundingClientRect().top) / pixelsPerMinute;
        let latestStart = minutesFromStart(props.event.start);
        let moved = false;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);

        const onMove = (moveEvent: PointerEvent) => {
          moved = moved || Math.abs(moveEvent.clientY - event.clientY) > 4;
          latestStart = clamp(
            snap(dayStartHour * 60 + (moveEvent.clientY - rect.top) / pixelsPerMinute - pointerOffsetMinutes),
            dayStartHour * 60,
            dayEndHour * 60 - duration,
          );
          if (moved) {
            setPreviewStartTime(timeFromMinutes(latestStart));
          }
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          setPreviewStartTime(undefined);
          if (!moved) {
            return;
          }
          props.onMove?.(timeFromMinutes(latestStart));
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <Badge variant={props.hasConflict ? 'destructive' : 'warning'} className="mb-1 w-fit">
        {props.hasConflict ? 'slot conflict' : props.previewOnly ? 'release to place' : 'draft booking'}
      </Badge>
      <strong className="truncate text-sm font-semibold">{props.event.title}</strong>
      <span className="truncate text-xs text-current/75">
        {formatRange(displayEvent.start, displayEvent.end)}
        {props.hasConflict ? ' - drag across an open slot' : ''}
      </span>
      {props.previewOnly ? null : (
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-md border border-rose-300/30 bg-rose-950/70 text-rose-100 shadow-sm transition hover:bg-rose-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-200/70"
            aria-label={`Discard draft meeting ${props.event.title}`}
            title="Discard draft"
            onClick={(event) => {
              event.stopPropagation();
              props.onDismiss?.();
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Trash2 className="size-3.5" />
          </button>
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-60"
            disabled={props.busy || props.hasConflict}
            onClick={(event) => {
              event.stopPropagation();
              props.onBook();
            }}
          >
            {props.busy ? 'Booking...' : 'Book'}
          </button>
        </div>
      )}
    </div>
  );
}

function DeleteConfirmationModal(props: {
  event: CalendarEvent;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-background/75 px-4 backdrop-blur-sm"
      role="presentation"
      onClick={() => {
        if (!props.busy) {
          props.onCancel();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-meeting-title"
        className="w-full max-w-md rounded-xl border border-rose-300/25 bg-card p-5 shadow-2xl shadow-black/40"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start gap-3">
          <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-rose-300/25 bg-rose-500/15 text-rose-200">
            <Trash2 className="size-4" />
          </div>
          <div>
            <h2 id="delete-meeting-title" className="text-lg font-semibold text-foreground">
              Delete this meeting?
            </h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              The broker will validate the delete before removing it from the calendar.
            </p>
          </div>
        </div>
        <div className="rounded-lg border border-border/60 bg-background/45 p-3">
          <strong className="block text-sm text-foreground">{props.event.title}</strong>
          <span className="mt-1 block text-sm text-muted-foreground">{formatRange(props.event.start, props.event.end)}</span>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={props.onCancel} disabled={props.busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={props.onConfirm} disabled={props.busy}>
            {props.busy ? 'Deleting...' : 'Delete meeting'}
          </Button>
        </div>
      </div>
    </div>
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
    queuedReadinessJobs: state.readinessJobs.filter((job) => job.status === 'queued').length,
    latestReadinessJob: state.readinessJobs[0] ?? null,
    note: 'Enable Foundry hosted agents in the AppHost to show hosted planner isolation for meeting readiness.',
  };
}

function buildWeekDays(events: CalendarEvent[]): Array<{ key: string; label: string; subtitle: string; count: number }> {
  const first = events.length === 0
    ? startOfDay(new Date(demoWeekStartIso))
    : startOfDay(new Date(Math.min(...events.map((event) => Date.parse(event.start)))));
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(first, index);
    const key = dateKey(date.toISOString());
    const count = events.filter((event) => dateKey(event.start) === key).length;
    return {
      key,
      label: new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(date),
      subtitle: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date),
      count,
    };
  });
}

function createDraftMeeting(form: NewMeetingForm, selectedDate: string): CalendarEvent {
  const title = form.title.trim() || 'New meeting';
  const start = dateTimeFromFields(form.dateKey || selectedDate, form.startTime);
  const end = new Date(start.getTime() + form.durationMinutes * 60000);
  return {
    id: 'draft-new-meeting',
    calendarId: primaryCalendarId,
    ownerId: demoUserId,
    title,
    kind: 'meeting',
    start: start.toISOString(),
    end: end.toISOString(),
    etag: '"draft-new-meeting:0"',
    attendees: parseAttendees(form.attendees),
    location: form.location.trim() || undefined,
    description: form.description.trim() || undefined,
  };
}

function hasCalendarConflict(events: CalendarEvent[], start: string, end: string): boolean {
  const startDay = dateKey(start);
  return events.some((event) => dateKey(event.start) === startDay && eventsOverlap(event, { start, end }));
}

function eventsOverlap(a: Pick<CalendarEvent, 'start' | 'end'>, b: Pick<CalendarEvent, 'start' | 'end'>): boolean {
  return Date.parse(a.start) < Date.parse(b.end) && Date.parse(a.end) > Date.parse(b.start);
}

function isOpenSlot(events: CalendarEvent[], startMinutes: number, endMinutes: number): boolean {
  return !events.some((event) => timeRangesOverlap(
    startMinutes,
    endMinutes,
    minutesFromStart(event.start),
    minutesFromStart(event.end),
  ));
}

function isOpenSlotForDraft(events: CalendarEvent[], draft: CalendarEvent, startTime: string, day: string): boolean {
  const duration = minutesBetween(draft.start, draft.end);
  const start = minutesFromTime(startTime);
  const dayEvents = events.filter((event) => dateKey(event.start) === day);
  return isOpenSlot(dayEvents, start, start + duration);
}

function findOpenStartTime(events: CalendarEvent[], day: string, durationMinutes: number, preferredStartMinutes: number): string {
  const dayEvents = events.filter((event) => dateKey(event.start) === day);
  const maxStart = dayEndHour * 60 - durationMinutes;
  const preferred = clamp(snap(preferredStartMinutes), dayStartHour * 60, maxStart);
  for (let start = preferred; start <= maxStart; start += snapMinutes) {
    if (isOpenSlot(dayEvents, start, start + durationMinutes)) {
      return timeFromMinutes(start);
    }
  }
  for (let start = dayStartHour * 60; start < preferred; start += snapMinutes) {
    if (isOpenSlot(dayEvents, start, start + durationMinutes)) {
      return timeFromMinutes(start);
    }
  }
  return timeFromMinutes(preferred);
}

function pointerMinutes(clientY: number, timelineTop: number): number {
  return clamp(
    snap(dayStartHour * 60 + (clientY - timelineTop) / pixelsPerMinute),
    dayStartHour * 60,
    dayEndHour * 60,
  );
}

function normalizeDraftSelection(anchorMinutes: number, currentMinutes: number): DraftSelection {
  const start = Math.min(anchorMinutes, currentMinutes);
  const end = Math.max(anchorMinutes, currentMinutes);
  if (end - start >= snapMinutes) {
    return { startMinutes: start, endMinutes: end, moved: false };
  }

  if (currentMinutes < anchorMinutes) {
    const adjustedStart = clamp(anchorMinutes - snapMinutes, dayStartHour * 60, dayEndHour * 60 - snapMinutes);
    return { startMinutes: adjustedStart, endMinutes: adjustedStart + snapMinutes, moved: false };
  }

  const adjustedEnd = clamp(anchorMinutes + snapMinutes, dayStartHour * 60 + snapMinutes, dayEndHour * 60);
  return { startMinutes: adjustedEnd - snapMinutes, endMinutes: adjustedEnd, moved: false };
}

function timeRangesOverlap(start: number, end: number, otherStart: number, otherEnd: number): boolean {
  return start < otherEnd && end > otherStart;
}

function suggestionKindLabel(kind: ReadinessSuggestion['kind']): string {
  return {
    'prep-time': 'Prep time',
    'weather-attire': 'Weather / attire',
    'travel-buffer': 'Travel buffer',
    'agenda-materials': 'Agenda / materials',
  }[kind];
}

function dateKey(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function dateTimeFromFields(dayKey: string, time: string): Date {
  const [year, month, day] = dayKey.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function timeFromMinutes(value: number): string {
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}

function parseAttendees(value: string): string[] {
  return value
    .split(/[,\n;]/)
    .map((attendee) => attendee.trim())
    .filter(Boolean);
}

function startOfDay(value: Date): Date {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(value: Date, days: number): Date {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function minutesFromStart(value: string): number {
  const date = new Date(value);
  return date.getHours() * 60 + date.getMinutes();
}

function minutesFromTime(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
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
