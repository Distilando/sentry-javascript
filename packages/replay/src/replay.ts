/* eslint-disable max-lines */ // TODO: We might want to split this file up
import { addGlobalEventProcessor, getCurrentHub, Scope, setContext } from '@sentry/core';
import { Breadcrumb, Client, DataCategory, Event, EventDropReason } from '@sentry/types';
import { addInstrumentationHandler, createEnvelope, logger } from '@sentry/utils';
import debounce from 'lodash.debounce';
import { PerformanceObserverEntryList } from 'perf_hooks';
import { EventType, record } from 'rrweb';

import {
  MAX_SESSION_LIFE,
  REPLAY_EVENT_NAME,
  SESSION_IDLE_DURATION,
  VISIBILITY_CHANGE_TIMEOUT,
  WINDOW,
} from './constants';
import { breadcrumbHandler } from './coreHandlers/breadcrumbHandler';
import { spanHandler } from './coreHandlers/spanHandler';
import { createMemoryEntry, createPerformanceEntries, ReplayPerformanceEntry } from './createPerformanceEntry';
import { createEventBuffer, EventBuffer } from './eventBuffer';
import { deleteSession } from './session/deleteSession';
import { getSession } from './session/getSession';
import { saveSession } from './session/saveSession';
import { Session } from './session/Session';
import type {
  AllPerformanceEntry,
  InstrumentationTypeBreadcrumb,
  InstrumentationTypeSpan,
  InternalEventContext,
  PopEventContext,
  RecordingEvent,
  RecordingOptions,
  ReplayPluginOptions,
  SendReplay,
} from './types';
import { addInternalBreadcrumb } from './util/addInternalBreadcrumb';
import { captureInternalException } from './util/captureInternalException';
import { createBreadcrumb } from './util/createBreadcrumb';
import { createPayload } from './util/createPayload';
import { dedupePerformanceEntries } from './util/dedupePerformanceEntries';
import { isExpired } from './util/isExpired';
import { isSessionExpired } from './util/isSessionExpired';

/**
 * Returns true to return control to calling function, otherwise continue with normal batching
 */
type AddUpdateCallback = () => boolean | void;

const BASE_RETRY_INTERVAL = 5000;
const MAX_RETRY_COUNT = 3;
const UNABLE_TO_SEND_REPLAY = 'Unable to send Replay';

export class ReplayContainer {
  public eventBuffer: EventBuffer | null = null;

  /**
   * List of PerformanceEntry from PerformanceObserver
   */
  public performanceEvents: AllPerformanceEntry[] = [];

  public session: Session | undefined;

  /**
   * Options to pass to `rrweb.record()`
   */
  readonly recordingOptions: RecordingOptions;

  readonly options: ReplayPluginOptions;

  private _performanceObserver: PerformanceObserver | null = null;

  private _retryCount: number = 0;
  private _retryInterval: number = BASE_RETRY_INTERVAL;

  private _debouncedFlush: ReturnType<typeof debounce>;
  private _flushLock: Promise<unknown> | null = null;

  /**
   * Timestamp of the last user activity. This lives across sessions.
   */
  private _lastActivity: number = new Date().getTime();

  /**
   * Is the integration currently active?
   */
  private _isEnabled: boolean = false;

  /**
   * Paused is a state where:
   * - DOM Recording is not listening at all
   * - Nothing will be added to event buffer (e.g. core SDK events)
   */
  private _isPaused: boolean = false;

  /**
   * Integration will wait until an error occurs before creating and sending a
   * replay.
   */
  private _waitForError: boolean = false;

  /**
   * Have we attached listeners to the core SDK?
   * Note we have to track this as there is no way to remove instrumentation handlers.
   */
  private _hasInitializedCoreListeners: boolean = false;

  /**
   * Function to stop recording
   */
  private _stopRecording: ReturnType<typeof record> | null = null;

  /**
   * We overwrite `client.recordDroppedEvent`, but store the original method here so we can restore it.
   */
  private _originalRecordDroppedEvent?: Client['recordDroppedEvent'];

  private _context: InternalEventContext = {
    errorIds: new Set(),
    traceIds: new Set(),
    urls: [],
    earliestEvent: null,
    initialTimestamp: new Date().getTime(),
    initialUrl: '',
  };

  constructor({ options, recordingOptions }: { options: ReplayPluginOptions; recordingOptions: RecordingOptions }) {
    this.recordingOptions = recordingOptions;
    this.options = options;

    this._debouncedFlush = debounce(() => this.flush(), this.options.flushMinDelay, {
      maxWait: this.options.flushMaxDelay,
    });
  }

  /**
   * Initializes the plugin.
   *
   * Creates or loads a session, attaches listeners to varying events (DOM,
   * _performanceObserver, Recording, Sentry SDK, etc)
   */
  start(): void {
    this.setInitialState();

    this.loadSession({ expiry: SESSION_IDLE_DURATION });

    // If there is no session, then something bad has happened - can't continue
    if (!this.session) {
      captureInternalException(new Error('Invalid session'));
      return;
    }

    if (!this.session.sampled) {
      // If session was not sampled, then we do not initialize the integration at all.
      return;
    }

    // Modify recording options to checkoutEveryNthSecond if
    // sampling for error replay. This is because we don't know
    // when an error will occur, so we need to keep a buffer of
    // replay events.
    if (this.session.sampled === 'error') {
      // Checkout every minute, meaning we only get up-to one minute of events before the error happens
      this.recordingOptions.checkoutEveryNms = 60000;
      this._waitForError = true;
    }

    // setup() is generally called on page load or manually - in both cases we
    // should treat it as an activity
    this.updateSessionActivity();

    this.eventBuffer = createEventBuffer({
      useCompression: Boolean(this.options.useCompression),
    });

    this.addListeners();

    this.startRecording();

    this._isEnabled = true;
  }

  /**
   * Start recording.
   *
   * Note that this will cause a new DOM checkout
   */
  startRecording(): void {
    try {
      this._stopRecording = record({
        ...this.recordingOptions,
        emit: this.handleRecordingEmit,
      });
    } catch (err) {
      __DEBUG_BUILD__ && logger.error('[Replay]', err);
      captureInternalException(err);
    }
  }

  /**
   * Currently, this needs to be manually called (e.g. for tests). Sentry SDK
   * does not support a teardown
   */
  stop(): void {
    try {
      __DEBUG_BUILD__ && logger.log('[Replay] Stopping Replays');
      this._isEnabled = false;
      this.removeListeners();
      this._stopRecording?.();
      this.eventBuffer?.destroy();
      this.eventBuffer = null;
    } catch (err) {
      __DEBUG_BUILD__ && logger.error('[Replay]', err);
      captureInternalException(err);
    }
  }

  /**
   * Pause some replay functionality. See comments for `_isPaused`.
   * This differs from stop as this only stops DOM recording, it is
   * not as thorough of a shutdown as `stop()`.
   */
  pause(): void {
    this._isPaused = true;
    try {
      if (this._stopRecording) {
        this._stopRecording();
        this._stopRecording = undefined;
      }
    } catch (err) {
      __DEBUG_BUILD__ && logger.error('[Replay]', err);
      captureInternalException(err);
    }
  }

  /**
   * Resumes recording, see notes for `pause().
   *
   * Note that calling `startRecording()` here will cause a
   * new DOM checkout.`
   */
  resume(): void {
    this._isPaused = false;
    this.startRecording();
  }

  /** for tests only */
  clearSession(): void {
    try {
      deleteSession();
      this.session = undefined;
    } catch (err) {
      __DEBUG_BUILD__ && logger.error('[Replay]', err);
      captureInternalException(err);
    }
  }

  /**
   * Loads a session from storage, or creates a new one if it does not exist or
   * is expired.
   */
  loadSession({ expiry }: { expiry: number }): void {
    const { type, session } = getSession({
      expiry,
      stickySession: Boolean(this.options.stickySession),
      currentSession: this.session,
      sessionSampleRate: this.options.sessionSampleRate,
      errorSampleRate: this.options.errorSampleRate,
    });

    // If session was newly created (i.e. was not loaded from storage), then
    // enable flag to create the root replay
    if (type === 'new') {
      this.setInitialState();
    }

    if (session.id !== this.session?.id) {
      session.previousSessionId = this.session?.id;
    }

    this.session = session;
  }

  /**
   * Capture some initial state that can change throughout the lifespan of the
   * replay. This is required because otherwise they would be captured at the
   * first flush.
   */
  setInitialState(): void {
    const urlPath = `${WINDOW.location.pathname}${WINDOW.location.hash}${WINDOW.location.search}`;
    const url = `${WINDOW.location.origin}${urlPath}`;

    this.performanceEvents = [];

    // Reset _context as well
    this.clearContext();

    this._context.initialUrl = url;
    this._context.initialTimestamp = new Date().getTime();
    this._context.urls.push(url);
  }

  /**
   * Adds listeners to record events for the replay
   */
  addListeners(): void {
    try {
      WINDOW.document.addEventListener('visibilitychange', this.handleVisibilityChange);
      WINDOW.addEventListener('blur', this.handleWindowBlur);
      WINDOW.addEventListener('focus', this.handleWindowFocus);

      // We need to filter out dropped events captured by `addGlobalEventProcessor(this.handleGlobalEvent)` below
      this._overwriteRecordDroppedEvent();

      // There is no way to remove these listeners, so ensure they are only added once
      if (!this._hasInitializedCoreListeners) {
        // Listeners from core SDK //
        const scope = getCurrentHub().getScope();
        scope?.addScopeListener(this.handleCoreBreadcrumbListener('scope'));
        addInstrumentationHandler('dom', this.handleCoreBreadcrumbListener('dom'));
        addInstrumentationHandler('fetch', this.handleCoreSpanListener('fetch'));
        addInstrumentationHandler('xhr', this.handleCoreSpanListener('xhr'));
        addInstrumentationHandler('history', this.handleCoreSpanListener('history'));

        // Tag all (non replay) events that get sent to Sentry with the current
        // replay ID so that we can reference them later in the UI
        addGlobalEventProcessor(this.handleGlobalEvent);

        this._hasInitializedCoreListeners = true;
      }
    } catch (err) {
      __DEBUG_BUILD__ && logger.error('[Replay]', err);
      captureInternalException(err);
    }

    // _performanceObserver //
    if (!('_performanceObserver' in WINDOW)) {
      return;
    }

    this._performanceObserver = new PerformanceObserver(this.handle_performanceObserver);

    // Observe almost everything for now (no mark/measure)
    [
      'element',
      'event',
      'first-input',
      'largest-contentful-paint',
      'layout-shift',
      'longtask',
      'navigation',
      'paint',
      'resource',
    ].forEach(type => {
      try {
        this._performanceObserver?.observe({
          type,
          buffered: true,
        });
      } catch {
        // This can throw if an entry type is not supported in the browser.
        // Ignore these errors.
      }
    });
  }

  /**
   * Cleans up listeners that were created in `addListeners`
   */
  removeListeners(): void {
    try {
      WINDOW.document.removeEventListener('visibilitychange', this.handleVisibilityChange);

      WINDOW.removeEventListener('blur', this.handleWindowBlur);
      WINDOW.removeEventListener('focus', this.handleWindowFocus);

      this._restoreRecordDroppedEvent();

      if (this._performanceObserver) {
        this._performanceObserver.disconnect();
        this._performanceObserver = null;
      }
    } catch (err) {
      __DEBUG_BUILD__ && logger.error('[Replay]', err);
      captureInternalException(err);
    }
  }

  /**
   * We want to batch uploads of replay events. Save events only if
   * `<flushMinDelay>` milliseconds have elapsed since the last event
   * *OR* if `<flushMaxDelay>` milliseconds have elapsed.
   *
   * Accepts a callback to perform side-effects and returns true to stop batch
   * processing and hand back control to caller.
   */
  addUpdate(cb?: AddUpdateCallback): void {
    // We need to always run `cb` (e.g. in the case of `this._waitForError == true`)
    const cbResult = cb?.();

    // If this option is turned on then we will only want to call `flush`
    // explicitly
    if (this._waitForError) {
      return;
    }

    // If callback is true, we do not want to continue with flushing -- the
    // caller will need to handle it.
    if (cbResult === true) {
      return;
    }

    // addUpdate is called quite frequently - use _debouncedFlush so that it
    // respects the flush delays and does not flush immediately
    this._debouncedFlush();
  }

  /**
   * Core Sentry SDK global event handler. Attaches `replayId` to all [non-replay]
   * events as a tag. Also handles the case where we only want to capture a reply
   * when an error occurs.
   **/
  handleGlobalEvent: (event: Event) => Event = (event: Event) => {
    // Do not apply replayId to the root event
    if (
      // @ts-ignore new event type
      event.type === REPLAY_EVENT_NAME
    ) {
      // Replays have separate set of breadcrumbs, do not include breadcrumbs
      // from core SDK
      delete event.breadcrumbs;
      return event;
    }

    // Only tag transactions with replayId if not waiting for an error
    if (event.type !== 'transaction' || !this._waitForError) {
      event.tags = { ...event.tags, replayId: this.session?.id };
    }

    // Collect traceIds in _context regardless of `_waitForError` - if it's true,
    // _context gets cleared on every checkout
    if (event.type === 'transaction') {
      this._context.traceIds.add(String(event.contexts?.trace?.trace_id || ''));
      return event;
    }

    // XXX: Is it safe to assume that all other events are error events?
    // @ts-ignore: Type 'undefined' is not assignable to type 'string'.ts(2345)
    this._context.errorIds.add(event.event_id);

    const exc = event.exception?.values?.[0];
    addInternalBreadcrumb({
      message: `Tagging event (${event.event_id}) - ${event.message} - ${exc?.type || 'Unknown'}: ${
        exc?.value || 'n/a'
      }`,
    });

    // Need to be very careful that this does not cause an infinite loop
    if (
      this._waitForError &&
      event.exception &&
      event.message !== UNABLE_TO_SEND_REPLAY // ignore this error because otherwise we could loop indefinitely with trying to capture replay and failing
    ) {
      setTimeout(async () => {
        // Allow flush to complete before resuming as a session recording, otherwise
        // the checkout from `startRecording` may be included in the payload.
        // Prefer to keep the error replay as a separate (and smaller) segment
        // than the session replay.
        await this.flushImmediate();

        if (this._stopRecording) {
          this._stopRecording();
          // Reset all "capture on error" configuration before
          // starting a new recording
          delete this.recordingOptions.checkoutEveryNms;
          this._waitForError = false;
          this.startRecording();
        }
      });
    }

    return event;
  };

  /**
   * Handler for recording events.
   *
   * Adds to event buffer, and has varying flushing behaviors if the event was a checkout.
   */
  handleRecordingEmit: (event: RecordingEvent, isCheckout?: boolean) => void = (
    event: RecordingEvent,
    isCheckout?: boolean,
  ) => {
    // If this is false, it means session is expired, create and a new session and wait for checkout
    if (!this.checkAndHandleExpiredSession()) {
      __DEBUG_BUILD__ && logger.error('[Replay] Received replay event after session expired.');

      return;
    }

    this.addUpdate(() => {
      // The session is always started immediately on pageload/init, but for
      // error-only replays, it should reflect the most recent checkout
      // when an error occurs. Clear any state that happens before this current
      // checkout. This needs to happen before `addEvent()` which updates state
      // dependent on this reset.
      if (this._waitForError && event.type === 2) {
        this.setInitialState();
      }

      // We need to clear existing events on a checkout, otherwise they are
      // incremental event updates and should be appended
      this.addEvent(event, isCheckout);

      // Different behavior for full snapshots (type=2), ignore other event types
      // See https://github.com/rrweb-io/rrweb/blob/d8f9290ca496712aa1e7d472549480c4e7876594/packages/rrweb/src/types.ts#L16
      if (event.type !== 2) {
        return false;
      }

      // If there is a previousSessionId after a full snapshot occurs, then
      // the replay session was started due to session expiration. The new session
      // is started before triggering a new checkout and contains the id
      // of the previous session. Do not immediately flush in this case
      // to avoid capturing only the checkout and instead the replay will
      // be captured if they perform any follow-up actions.
      if (this.session?.previousSessionId) {
        return true;
      }

      // See note above re: session start needs to reflect the most recent
      // checkout.
      if (this._waitForError && this.session && this._context.earliestEvent) {
        this.session.started = this._context.earliestEvent;
        this._maybeSaveSession();
      }

      // If the full snapshot is due to an initial load, we will not have
      // a previous session ID. In this case, we want to buffer events
      // for a set amount of time before flushing. This can help avoid
      // capturing replays of users that immediately close the window.
      setTimeout(() => this.conditionalFlush(), this.options.initialFlushDelay);

      // Cancel any previously debounced flushes to ensure there are no [near]
      // simultaneous flushes happening. The latter request should be
      // insignificant in this case, so wait for additional user interaction to
      // trigger a new flush.
      //
      // This can happen because there's no guarantee that a recording event
      // happens first. e.g. a mouse click can happen and trigger a debounced
      // flush before the checkout.
      this._debouncedFlush?.cancel();

      return true;
    });
  };

  /**
   * Handle when visibility of the page content changes. Opening a new tab will
   * cause the state to change to hidden because of content of current page will
   * be hidden. Likewise, moving a different window to cover the contents of the
   * page will also trigger a change to a hidden state.
   */
  handleVisibilityChange: () => void = () => {
    if (WINDOW.document.visibilityState === 'visible') {
      this.doChangeToForegroundTasks();
    } else {
      this.doChangeToBackgroundTasks();
    }
  };

  /**
   * Handle when page is blurred
   */
  handleWindowBlur: () => void = () => {
    const breadcrumb = createBreadcrumb({
      category: 'ui.blur',
    });

    // Do not count blur as a user action -- it's part of the process of them
    // leaving the page
    this.doChangeToBackgroundTasks(breadcrumb);
  };

  /**
   * Handle when page is focused
   */
  handleWindowFocus: () => void = () => {
    const breadcrumb = createBreadcrumb({
      category: 'ui.focus',
    });

    // Do not count focus as a user action -- instead wait until they focus and
    // interactive with page
    this.doChangeToForegroundTasks(breadcrumb);
  };

  /**
   * Handler for Sentry Core SDK events.
   *
   * These specific events will create span-like objects in the recording.
   */
  handleCoreSpanListener: (type: InstrumentationTypeSpan) => (handlerData: unknown) => void =
    (type: InstrumentationTypeSpan) =>
    (handlerData: unknown): void => {
      if (!this._isEnabled) {
        return;
      }

      const result = spanHandler(type, handlerData);

      if (result === null) {
        return;
      }

      if (type === 'history') {
        // Need to collect visited URLs
        this._context.urls.push(result.name);
        this.triggerUserActivity();
      }

      this.addUpdate(() => {
        void this.createPerformanceSpans([result as ReplayPerformanceEntry]);
        // Returning true will cause `addUpdate` to not flush
        // We do not want network requests to cause a flush. This will prevent
        // recurring/polling requests from keeping the replay session alive.
        return ['xhr', 'fetch'].includes(type);
      });
    };

  /**
   * Handler for Sentry Core SDK events.
   *
   * These events will create breadcrumb-like objects in the recording.
   */
  handleCoreBreadcrumbListener: (type: InstrumentationTypeBreadcrumb) => (handlerData: unknown) => void =
    (type: InstrumentationTypeBreadcrumb) =>
    (handlerData: unknown): void => {
      if (!this._isEnabled) {
        return;
      }

      const result = breadcrumbHandler(type, handlerData);

      if (result === null) {
        return;
      }

      if (result.category === 'sentry.transaction') {
        return;
      }

      if (result.category === 'ui.click') {
        this.triggerUserActivity();
      } else {
        this.checkAndHandleExpiredSession();
      }

      this.addUpdate(() => {
        this.addEvent({
          type: EventType.Custom,
          // TODO: We were converting from ms to seconds for breadcrumbs, spans,
          // but maybe we should just keep them as milliseconds
          timestamp: (result.timestamp || 0) * 1000,
          data: {
            tag: 'breadcrumb',
            payload: result,
          },
        });

        // Do not flush after console log messages
        return result.category === 'console';
      });
    };

  /**
   * Keep a list of performance entries that will be sent with a replay
   */
  handle_performanceObserver: (list: PerformanceObserverEntryList) => void = (list: PerformanceObserverEntryList) => {
    // For whatever reason the observer was returning duplicate navigation
    // entries (the other entry types were not duplicated).
    const newPerformanceEntries = dedupePerformanceEntries(
      this.performanceEvents,
      list.getEntries() as AllPerformanceEntry[],
    );
    this.performanceEvents = newPerformanceEntries;
  };

  /**
   * Tasks to run when we consider a page to be hidden (via blurring and/or visibility)
   */
  doChangeToBackgroundTasks(breadcrumb?: Breadcrumb): void {
    if (!this.session) {
      return;
    }

    const expired = isSessionExpired(this.session, VISIBILITY_CHANGE_TIMEOUT);

    if (breadcrumb && !expired) {
      this.createCustomBreadcrumb(breadcrumb);
    }

    // Send replay when the page/tab becomes hidden. There is no reason to send
    // replay if it becomes visible, since no actions we care about were done
    // while it was hidden
    this.conditionalFlush();
  }

  /**
   * Tasks to run when we consider a page to be visible (via focus and/or visibility)
   */
  doChangeToForegroundTasks(breadcrumb?: Breadcrumb): void {
    if (!this.session) {
      return;
    }

    const isSessionActive = this.checkAndHandleExpiredSession({
      expiry: VISIBILITY_CHANGE_TIMEOUT,
    });

    if (!isSessionActive) {
      // If the user has come back to the page within VISIBILITY_CHANGE_TIMEOUT
      // ms, we will re-use the existing session, otherwise create a new
      // session
      __DEBUG_BUILD__ && logger.log('[Replay] Document has become active, but session has expired');
      return;
    }

    if (breadcrumb) {
      this.createCustomBreadcrumb(breadcrumb);
    }
  }

  /**
   * Trigger rrweb to take a full snapshot which will cause this plugin to
   * create a new Replay event.
   */
  triggerFullSnapshot(): void {
    __DEBUG_BUILD__ && logger.log('[Replay] Taking full rrweb snapshot');
    record.takeFullSnapshot(true);
  }

  /**
   * Add an event to the event buffer
   */
  addEvent(event: RecordingEvent, isCheckout?: boolean): void {
    if (!this.eventBuffer) {
      // This implies that `_isEnabled` is false
      return;
    }

    if (this._isPaused) {
      // Do not add to event buffer when recording is paused
      return;
    }

    // TODO: sadness -- we will want to normalize timestamps to be in ms -
    // requires coordination with frontend
    const isMs = event.timestamp > 9999999999;
    const timestampInMs = isMs ? event.timestamp : event.timestamp * 1000;

    // Throw out events that happen more than 5 minutes ago. This can happen if
    // page has been left open and idle for a long period of time and user
    // comes back to trigger a new session. The performance entries rely on
    // `performance.timeOrigin`, which is when the page first opened.
    if (timestampInMs + SESSION_IDLE_DURATION < new Date().getTime()) {
      return;
    }

    // Only record earliest event if a new session was created, otherwise it
    // shouldn't be relevant
    if (
      this.session?.segmentId === 0 &&
      (!this._context.earliestEvent || timestampInMs < this._context.earliestEvent)
    ) {
      this._context.earliestEvent = timestampInMs;
    }

    this.eventBuffer.addEvent(event, isCheckout);
  }

  /**
   * Update user activity (across session lifespans)
   */
  updateUserActivity(_lastActivity: number = new Date().getTime()): void {
    this._lastActivity = _lastActivity;
  }

  /**
   * Updates the session's last activity timestamp
   */
  updateSessionActivity(_lastActivity: number = new Date().getTime()): void {
    if (this.session) {
      this.session.lastActivity = _lastActivity;
      this._maybeSaveSession();
    }
  }

  /**
   * Updates the user activity timestamp and resumes recording. This should be
   * called in an event handler for a user action that we consider as the user
   * being "active" (e.g. a mouse click).
   */
  triggerUserActivity(): void {
    this.updateUserActivity();

    // This case means that recording was once stopped due to inactivity.
    // Ensure that recording is resumed.
    if (!this._stopRecording) {
      // Create a new session, otherwise when the user action is flushed, it
      // will get rejected due to an expired session.
      this.loadSession({ expiry: SESSION_IDLE_DURATION });

      // Note: This will cause a new DOM checkout
      this.resume();
      return;
    }

    // Otherwise... recording was never suspended, continue as normalish
    this.checkAndHandleExpiredSession();

    this.updateSessionActivity();
  }

  /**
   * Helper to create (and buffer) a replay breadcrumb from a core SDK breadcrumb
   */
  createCustomBreadcrumb(breadcrumb: Breadcrumb): void {
    this.addUpdate(() => {
      this.addEvent({
        type: EventType.Custom,
        timestamp: breadcrumb.timestamp || 0,
        data: {
          tag: 'breadcrumb',
          payload: breadcrumb,
        },
      });
    });
  }

  /**
   * Create a "span" for each performance entry. The parent transaction is `this.replayEvent`.
   */
  createPerformanceSpans(entries: ReplayPerformanceEntry[]): Promise<void[]> {
    return Promise.all(
      entries.map(({ type, start, end, name, data }) =>
        this.addEvent({
          type: EventType.Custom,
          timestamp: start,
          data: {
            tag: 'performanceSpan',
            payload: {
              op: type,
              description: name,
              startTimestamp: start,
              endTimestamp: end,
              data,
            },
          },
        }),
      ),
    );
  }

  /**
   * Observed performance events are added to `this.performanceEvents`. These
   * are included in the replay event before it is finished and sent to Sentry.
   */
  addPerformanceEntries(): Promise<void[]> {
    // Copy and reset entries before processing
    const entries = [...this.performanceEvents];
    this.performanceEvents = [];

    return this.createPerformanceSpans(createPerformanceEntries(entries));
  }

  /**
   * Create a "span" for the total amount of memory being used by JS objects
   * (including v8 internal objects).
   */
  addMemoryEntry(): Promise<void[]> | undefined {
    // window.performance.memory is a non-standard API and doesn't work on all browsers
    // so we check before creating the event.
    if (!('memory' in WINDOW.performance)) {
      return;
    }

    return this.createPerformanceSpans([
      // @ts-ignore memory doesn't exist on type Performance as the API is non-standard (we check that it exists above)
      createMemoryEntry(WINDOW.performance.memory),
    ]);
  }

  /**
   * Checks if recording should be stopped due to user inactivity. Otherwise
   * check if session is expired and create a new session if so. Triggers a new
   * full snapshot on new session.
   *
   * Returns true if session is not expired, false otherwise.
   */
  checkAndHandleExpiredSession({ expiry = SESSION_IDLE_DURATION }: { expiry?: number } = {}): boolean | void {
    const oldSessionId = this.session?.id;

    // Prevent starting a new session if the last user activity is older than
    // MAX_SESSION_LIFE. Otherwise non-user activity can trigger a new
    // session+recording. This creates noisy replays that do not have much
    // content in them.
    if (this._lastActivity && isExpired(this._lastActivity, MAX_SESSION_LIFE)) {
      // Pause recording
      this.pause();
      return;
    }

    // --- There is recent user activity --- //
    // This will create a new session if expired, based on expiry length
    this.loadSession({ expiry });

    // Session was expired if session ids do not match
    const expired = oldSessionId !== this.session?.id;

    if (!expired) {
      return true;
    }

    // Session is expired, trigger a full snapshot (which will create a new session)
    this.triggerFullSnapshot();

    return false;
  }

  /**
   * Only flush if `this._waitForError` is false.
   */
  conditionalFlush(): void {
    if (this._waitForError) {
      return;
    }

    void this.flushImmediate();
  }

  /**
   * Clear _context
   */
  clearContext(): void {
    // XXX: `initialTimestamp` and `initialUrl` do not get cleared
    this._context.errorIds.clear();
    this._context.traceIds.clear();
    this._context.urls = [];
    this._context.earliestEvent = null;
  }

  /**
   * Return and clear _context
   */
  popEventContext(): PopEventContext {
    if (this._context.earliestEvent && this._context.earliestEvent < this._context.initialTimestamp) {
      this._context.initialTimestamp = this._context.earliestEvent;
    }

    const _context = {
      initialTimestamp: this._context.initialTimestamp,
      initialUrl: this._context.initialUrl,
      errorIds: Array.from(this._context.errorIds).filter(Boolean),
      traceIds: Array.from(this._context.traceIds).filter(Boolean),
      urls: this._context.urls,
    };

    this.clearContext();

    return _context;
  }

  /**
   * Flushes replay event buffer to Sentry.
   *
   * Performance events are only added right before flushing - this is
   * due to the buffered performance observer events.
   *
   * Should never be called directly, only by `flush`
   */
  async runFlush(): Promise<void> {
    if (!this.session) {
      __DEBUG_BUILD__ && logger.error('[Replay] No session found to flush.');
      return;
    }

    await this.addPerformanceEntries();

    if (!this.eventBuffer?.length) {
      return;
    }

    // Only attach memory event if eventBuffer is not empty
    await this.addMemoryEntry();

    try {
      // Note this empties the event buffer regardless of outcome of sending replay
      const recordingData = await this.eventBuffer.finish();

      // NOTE: Copy values from instance members, as it's possible they could
      // change before the flush finishes.
      const replayId = this.session.id;
      const eventContext = this.popEventContext();
      // Always increment segmentId regardless of outcome of sending replay
      const segmentId = this.session.segmentId++;
      this._maybeSaveSession();

      await this.sendReplay({
        replayId,
        events: recordingData,
        segmentId,
        includeReplayStartTimestamp: segmentId === 0,
        eventContext,
      });
    } catch (err) {
      __DEBUG_BUILD__ && logger.error(err);
      captureInternalException(err);
    }
  }

  /**
   * Flush recording data to Sentry. Creates a lock so that only a single flush
   * can be active at a time. Do not call this directly.
   */
  flush: () => Promise<void> = async () => {
    if (!this._isEnabled) {
      // This is just a precaution, there should be no listeners that would
      // cause a flush.
      return;
    }

    if (!this.checkAndHandleExpiredSession()) {
      __DEBUG_BUILD__ && logger.error('[Replay] Attempting to finish replay event after session expired.');
      return;
    }

    if (!this.session?.id) {
      __DEBUG_BUILD__ && logger.error('[Replay] No session found to flush.');
      return;
    }

    // A flush is about to happen, cancel any queued flushes
    this._debouncedFlush?.cancel();

    // No existing flush in progress, proceed with flushing.
    // this._flushLock acts as a lock so that future calls to `flush()`
    // will be blocked until this promise resolves
    if (!this._flushLock) {
      this._flushLock = this.runFlush();
      await this._flushLock;
      this._flushLock = null;
      return;
    }

    // Wait for previous flush to finish, then call the debounced `flush()`.
    // It's possible there are other flush requests queued and waiting for it
    // to resolve. We want to reduce all outstanding requests (as well as any
    // new flush requests that occur within a second of the locked flush
    // completing) into a single flush.

    try {
      await this._flushLock;
    } catch (err) {
      __DEBUG_BUILD__ && logger.error(err);
    } finally {
      this._debouncedFlush();
    }
  };

  /**
   *
   * Always flush via `_debouncedFlush` so that we do not have flushes triggered
   * from calling both `flush` and `_debouncedFlush`. Otherwise, there could be
   * cases of mulitple flushes happening closely together.
   */
  flushImmediate(): Promise<void> {
    this._debouncedFlush();
    // `.flush` is provided by lodash.debounce
    return this._debouncedFlush.flush();
  }

  /**
   * Send replay attachment using `fetch()`
   */
  async sendReplayRequest({
    events,
    replayId: event_id,
    segmentId: segment_id,
    includeReplayStartTimestamp,
    eventContext,
  }: SendReplay): Promise<void | undefined> {
    const payloadWithSequence = createPayload({
      events,
      headers: {
        segment_id,
      },
    });

    const { urls, errorIds, traceIds, initialTimestamp } = eventContext;

    const currentTimestamp = new Date().getTime();

    const sdkInfo = {
      name: 'sentry.javascript.integration.replay',
      version: __SENTRY_REPLAY_VERSION__,
    };

    const replayEvent = await new Promise(resolve => {
      getCurrentHub()
        // @ts-ignore private api
        ?._withClient(async (client: Client, scope: Scope) => {
          // XXX: This event does not trigger `beforeSend` in SDK
          // @ts-ignore private api
          const preparedEvent: Event = await client._prepareEvent(
            {
              type: REPLAY_EVENT_NAME,
              ...(includeReplayStartTimestamp ? { replay_start_timestamp: initialTimestamp / 1000 } : {}),
              timestamp: currentTimestamp / 1000,
              error_ids: errorIds,
              trace_ids: traceIds,
              urls,
              replay_id: event_id,
              segment_id,
            },
            { event_id },
            scope,
          );
          const session = scope && scope.getSession();
          if (session) {
            // @ts-ignore private api
            client._updateSessionFromEvent(session, preparedEvent);
          }

          preparedEvent.sdk = {
            ...preparedEvent.sdk,
            ...sdkInfo,
          };

          preparedEvent.tags = {
            ...preparedEvent.tags,
            sessionSampleRate: this.options.sessionSampleRate,
            errorSampleRate: this.options.errorSampleRate,
            replayType: this.session?.sampled,
          };

          resolve(preparedEvent);
        });
    });

    const envelope = createEnvelope(
      {
        event_id,
        sent_at: new Date().toISOString(),
        sdk: sdkInfo,
      },
      [
        // @ts-ignore New types
        [{ type: 'replay_event' }, replayEvent],
        [
          {
            // @ts-ignore setting envelope
            type: 'replay_recording',
            length: payloadWithSequence.length,
          },
          // @ts-ignore: Type 'string' is not assignable to type 'ClientReport'.ts(2322)
          payloadWithSequence,
        ],
      ],
    );

    const client = getCurrentHub().getClient();
    try {
      return client?.getTransport()?.send(envelope);
    } catch {
      throw new Error(UNABLE_TO_SEND_REPLAY);
    }
  }

  resetRetries(): void {
    this._retryCount = 0;
    this._retryInterval = BASE_RETRY_INTERVAL;
  }

  /**
   * Finalize and send the current replay event to Sentry
   */
  async sendReplay({
    replayId,
    events,
    segmentId,
    includeReplayStartTimestamp,
    eventContext,
  }: SendReplay): Promise<unknown> {
    // short circuit if there's no events to upload (this shouldn't happen as runFlush makes this check)
    if (!events.length) {
      return;
    }

    try {
      await this.sendReplayRequest({
        events,
        replayId,
        segmentId,
        includeReplayStartTimestamp,
        eventContext,
      });
      this.resetRetries();
      return true;
    } catch (err) {
      __DEBUG_BUILD__ && logger.error(err);
      // Capture error for every failed replay
      setContext('Replays', {
        _retryCount: this._retryCount,
      });
      captureInternalException(err);

      // If an error happened here, it's likely that uploading the attachment
      // failed, we'll can retry with the same events payload
      if (this._retryCount >= MAX_RETRY_COUNT) {
        throw new Error(`${UNABLE_TO_SEND_REPLAY} - max retries exceeded`);
      }

      this._retryCount = this._retryCount + 1;
      // will retry in intervals of 5, 10, 30
      this._retryInterval = this._retryCount * this._retryInterval;

      return await new Promise((resolve, reject) => {
        setTimeout(async () => {
          try {
            await this.sendReplay({
              replayId,
              events,
              segmentId,
              includeReplayStartTimestamp,
              eventContext,
            });
            resolve(true);
          } catch (err) {
            reject(err);
          }
        }, this._retryInterval);
      });
    }
  }

  /** Save the session, if it is sticky */
  private _maybeSaveSession(): void {
    if (this.session && this.options.stickySession) {
      saveSession(this.session);
    }
  }

  private _overwriteRecordDroppedEvent(): void {
    const client = getCurrentHub().getClient();

    if (!client) {
      return;
    }

    const _originalCallback = client.recordDroppedEvent.bind(client);

    const recordDroppedEvent: Client['recordDroppedEvent'] = (
      reason: EventDropReason,
      category: DataCategory,
      event?: Event,
    ): void => {
      if (event && event.event_id) {
        this._context.errorIds.delete(event.event_id);
      }

      return _originalCallback(reason, category, event);
    };

    client.recordDroppedEvent = recordDroppedEvent;
    this._originalRecordDroppedEvent = _originalCallback;
  }

  private _restoreRecordDroppedEvent(): void {
    const client = getCurrentHub().getClient();

    if (!client || !this._originalRecordDroppedEvent) {
      return;
    }

    client.recordDroppedEvent = this._originalRecordDroppedEvent;
  }
}
