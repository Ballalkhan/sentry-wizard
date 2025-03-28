import {
  Hub,
  Integrations,
  NodeClient,
  type Span,
  defaultStackParser,
  flush,
  makeMain,
  makeNodeTransport,
  runWithAsyncContext,
  setTag,
  startSpan,
} from '@sentry/node';
import type { WizardOptions } from './utils/types';
import { WIZARD_VERSION } from './version';

export async function withTelemetry<F>(
  options: {
    enabled: boolean;
    integration: string;
    wizardOptions: WizardOptions;
  },
  callback: () => F | Promise<F>,
): Promise<F> {
  const { sentryHub, sentryClient } = createSentryInstance(
    options.enabled,
    options.integration,
  );

  makeMain(sentryHub);

  const sentrySession = sentryHub.startSession();
  sentryHub.captureSession();

  // Set tag for passed CLI args
  sentryHub.setTag('args.project', !!options.wizardOptions.projectSlug);
  sentryHub.setTag('args.org', !!options.wizardOptions.orgSlug);
  sentryHub.setTag('args.saas', !!options.wizardOptions.saas);

  try {
    return await startSpan(
      {
        name: 'sentry-wizard-execution',
        status: 'ok',
        op: 'wizard.flow',
      },
      async () => {
        updateProgress('start');
        const res = await runWithAsyncContext(callback);
        updateProgress('finished');

        return res;
      },
    );
  } catch (e) {
    sentryHub.captureException('Error during wizard execution.');
    sentrySession.status = 'crashed';
    throw e;
  } finally {
    sentryHub.endSession();
    await sentryClient.flush(3000).then(null, () => {
      // If telemetry flushing fails we generally don't care
    });
    await flush(3000).then(null, () => {
      // If telemetry flushing fails we generally don't care
    });
  }
}

function createSentryInstance(enabled: boolean, integration: string) {
  const client = new NodeClient({
    dsn: 'https://8871d3ff64814ed8960c96d1fcc98a27@o1.ingest.sentry.io/4505425820712960',
    enabled: enabled,

    environment: `production-${integration}`,

    tracesSampleRate: 1,
    sampleRate: 1,

    release: WIZARD_VERSION,
    integrations: [new Integrations.Http()],
    tracePropagationTargets: [/^https:\/\/sentry.io\//],

    stackParser: defaultStackParser,

    beforeSendTransaction: (event) => {
      delete event.server_name; // Server name might contain PII
      return event;
    },

    beforeSend: (event) => {
      event.exception?.values?.forEach((exception) => {
        delete exception.stacktrace;
      });

      delete event.server_name; // Server name might contain PII
      return event;
    },

    transport: makeNodeTransport,

    debug: true,
  });

  const hub = new Hub(client);

  hub.setTag('integration', integration);
  hub.setTag('node', process.version);
  hub.setTag('platform', process.platform);

  try {
    // The `require` call here is fine because the binary node versions
    // support `require` and we try/catch the call anyway for any other
    // version of node.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sea = require('node:sea') as { isSea: () => boolean };
    hub.setTag('is_binary', sea.isSea());
  } catch {
    hub.setTag('is_binary', false);
  }

  return { sentryHub: hub, sentryClient: client };
}

export function traceStep<T>(
  step: string,
  callback: (span: Span | undefined) => T,
): T {
  updateProgress(step);
  return startSpan({ name: step, op: 'wizard.step' }, (span) => callback(span));
}

export function updateProgress(step: string) {
  setTag('progress', step);
}
