import { getCurrentHub } from '@sentry/core';

import { REPLAY_EVENT_NAME } from '../../src/constants';
import { ReplayContainer } from './../../src/replay';
import { Error } from './../fixtures/error';
import { Transaction } from './../fixtures/transaction';
import { resetSdkMock } from './../mocks';
import { useFakeTimers } from './../utils/use-fake-timers';

useFakeTimers();
let replay: ReplayContainer;

beforeEach(async () => {
  ({ replay } = await resetSdkMock({
    replayOptions: {
      stickySession: false,
    },
    sentryOptions: {
      replaysSessionSampleRate: 0.0,
      replaysOnErrorSampleRate: 1.0,
    },
  }));
});

afterEach(() => {
  replay.stop();
});

it('deletes breadcrumbs from replay events', () => {
  const replayEvent = {
    type: REPLAY_EVENT_NAME,
    breadcrumbs: [{ type: 'fakecrumb' }],
  };

  // @ts-ignore replay event type
  expect(replay.handleGlobalEvent(replayEvent)).toEqual({
    type: REPLAY_EVENT_NAME,
  });
});

it('does not delete breadcrumbs from error and transaction events', () => {
  expect(
    replay.handleGlobalEvent({
      breadcrumbs: [{ type: 'fakecrumb' }],
    }),
  ).toEqual(
    expect.objectContaining({
      breadcrumbs: [{ type: 'fakecrumb' }],
    }),
  );
  expect(
    replay.handleGlobalEvent({
      type: 'transaction',
      breadcrumbs: [{ type: 'fakecrumb' }],
    }),
  ).toEqual(
    expect.objectContaining({
      breadcrumbs: [{ type: 'fakecrumb' }],
    }),
  );
});

it('only tags errors with replay id, adds trace and error id to context for error samples', async () => {
  const transaction = Transaction();
  const error = Error();
  // @ts-ignore idc
  expect(replay.handleGlobalEvent(transaction)).toEqual(
    expect.objectContaining({
      tags: expect.not.objectContaining({ replayId: expect.anything() }),
    }),
  );
  expect(replay.handleGlobalEvent(error)).toEqual(
    expect.objectContaining({
      tags: expect.objectContaining({ replayId: expect.any(String) }),
    }),
  );

  // @ts-ignore private
  expect(replay._context.traceIds).toContain('trace_id');
  // @ts-ignore private
  expect(replay._context.errorIds).toContain('event_id');

  jest.runAllTimers();
  await new Promise(process.nextTick); // wait for flush

  // Turns off `_waitForError` mode
  // @ts-ignore private
  expect(replay._waitForError).toBe(false);
});

it('strips out dropped events from errorIds', async () => {
  const error1 = Error({ event_id: 'err1' });
  const error2 = Error({ event_id: 'err2' });
  const error3 = Error({ event_id: 'err3' });

  replay['_overwriteRecordDroppedEvent']();

  const client = getCurrentHub().getClient()!;

  replay.handleGlobalEvent(error1);
  replay.handleGlobalEvent(error2);
  replay.handleGlobalEvent(error3);

  client.recordDroppedEvent('before_send', 'error', { event_id: 'err2' });

  // @ts-ignore private
  expect(Array.from(replay._context.errorIds)).toEqual(['err1', 'err3']);

  replay['_restoreRecordDroppedEvent']();
});

it('tags errors and transactions with replay id for session samples', async () => {
  ({ replay } = await resetSdkMock({}));
  replay.start();
  const transaction = Transaction();
  const error = Error();
  // @ts-ignore idc
  expect(replay.handleGlobalEvent(transaction)).toEqual(
    expect.objectContaining({
      tags: expect.objectContaining({ replayId: expect.any(String) }),
    }),
  );
  expect(replay.handleGlobalEvent(error)).toEqual(
    expect.objectContaining({
      tags: expect.objectContaining({ replayId: expect.any(String) }),
    }),
  );
});
