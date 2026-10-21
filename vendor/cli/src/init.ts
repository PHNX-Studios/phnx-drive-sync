import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { FeatureFlags, Logger, OpenPGPCryptoWithCryptoProxy, ProtonDriveClient } from '@protontech/drive-sdk';
import { initDiagnostic } from '@protontech/drive-sdk/diagnostic';
import { ProtonDrivePhotosClient } from '@protontech/drive-sdk/protonDrivePhotosClient';

import { initApi } from './api';
import { createCaches } from './cache';
import { Paths } from './cli';
import { getOrGenerateClientUid } from './clientUid';
import { getConfig, InitConfig } from './config';
import { initCredentials } from './credentials';
import { Manager, NoEventsProvider, PersistedEventsProvider } from './events';
import { disableSentry, initTelemetry } from './telemetry';

export async function init(configOptions: InitConfig) {
    try {
        return await initUnguarded(configOptions);
    } catch (e) {
        // drive-sync: a failed init (expired session, offline) must not leave the
        // process-wide crypto endpoint claimed, or every retry throws "already initialised"
        await releaseOpenPGPCryptoModule();
        throw e;
    }
}

async function initUnguarded(configOptions: InitConfig) {
    const config = getConfig(configOptions);
    await Promise.all([
        mkdir(config.cacheDir, { recursive: true }),
        mkdir(config.appDir, { recursive: true }),
        mkdir(config.logDir, { recursive: true }),
    ]);

    const { telemetry, metrics, enableMetrics, flush: flushTelemetry } = initTelemetry(config);
    const logger = telemetry.getLogger('cli');

    logger.info(`Version: CLI=${configOptions.appVersion}, SDK=${configOptions.sdkVersion ?? 'unknown'}`);

    const openPGPCryptoModule = await initOpenPGPCryptoModule();
    const cryptoGeneration = endpointGeneration;
    const credentials = initCredentials(config, logger);
    const { auth, addresses, srp, httpClient, apiClient } = await initApi(config, credentials, logger, CryptoProxy);

    // Sentry is enabled from the start to collect crashes before any user
    // operation is performed to avoid going blind in case of a hard crash.
    // Once the core application is running and the telemetry preference is
    // known, the metrics are enabled or disabled accordingly.
    logger.debug(`Telemetry enabled: build=${configOptions.enableMetrics}, user=${credentials.isTelemetryEnabled()}`);
    if (credentials.isTelemetryEnabled()) {
        // TODO: Once we have Account SDK, get the user plan from the auth object.
        enableMetrics(apiClient, 'unknown');
    } else {
        disableSentry();
    }

    const clientUid = await getOrGenerateClientUid(config, logger);
    const caches = createCaches(config, credentials, logger);
    const eventsProvider = config.enablePersistedEvents
        ? await PersistedEventsProvider.open(logger, config.appDir)
        : new NoEventsProvider();

    const sdkDependencies = {
        config: {
            baseUrl: config.baseUrl,
            clientUid,
        },
        httpClient,
        entitiesCache: caches.entitiesCache,
        cryptoCache: caches.cryptoCache,
        telemetry,
        openPGPCryptoModule,
        account: addresses,
        srpModule: srp,
        latestEventIdProvider: eventsProvider,
        featureFlagProvider: configOptions.flags
            ? new FeatureFlagProvider(configOptions.flags)
            : await FeatureFlagProvider.fromJsonFile(path.join(config.appDir, 'config.json')),
        searchServiceProvider: configOptions.searchServiceProvider,
    };
    const sdk = new ProtonDriveClient(sdkDependencies);
    const photosSdk = new ProtonDrivePhotosClient(sdkDependencies);
    const sdkDiagnostic = initDiagnostic(sdkDependencies);

    const eventsManager = await Manager.create(logger, sdk, photosSdk, eventsProvider, auth.isLoggedIn());

    const paths = new Paths(sdk, photosSdk, auth, eventsManager);

    return {
        config,
        logger: logger as Logger,
        auth,
        addresses,
        apiClient, // drive-sync: used for account quota (storage) queries
        sdk,
        photosSdk,
        sdkDiagnostic,
        paths,
        eventsManager,
        eventsProvider,
        metrics,
        dispose: async () => {
            await Promise.all([flushTelemetry(), eventsManager.dispose()]);
            // drive-sync: free the process-wide crypto endpoint so the next init() can claim it
            // (skipped when a newer init() already replaced it; a late dispose must not pull it away)
            if (cryptoGeneration === endpointGeneration) await releaseOpenPGPCryptoModule();
        },
        clearCaches: async () => {
            logger.debug('Clearing caches');
            await Promise.allSettled([eventsManager.clear(), caches.cryptoCache.clear(), caches.entitiesCache.clear()]);
        },
    };
}

// drive-sync: idempotent (the proxy endpoint is a process-wide singleton and the
// engine re-runs init() on every boot retry), and exported for tests.
let endpointGeneration = 0;

export async function initOpenPGPCryptoModule() {
    await releaseOpenPGPCryptoModule();
    endpointGeneration++;
    CryptoApi.init({});
    CryptoProxy.setEndpoint(new CryptoApi(), (endpoint) => endpoint.clearKeyStore());
    return new OpenPGPCryptoWithCryptoProxy(CryptoProxy);
}

/** drive-sync: release the crypto endpoint if one is set (releaseEndpoint throws when unset). */
export async function releaseOpenPGPCryptoModule(): Promise<void> {
    try {
        await CryptoProxy.releaseEndpoint();
    } catch {
        /* no endpoint set */
    }
}

class FeatureFlagProvider {
    constructor(private flags: Record<FeatureFlags, boolean>) {
        this.flags = flags;
    }

    static async fromJsonFile(jsonFile: string) {
        const file = Bun.file(jsonFile);

        if (!(await file.exists())) {
            return new FeatureFlagProvider({} as Record<FeatureFlags, boolean>);
        }

        const bytes = await file.bytes();
        const content = new TextDecoder().decode(bytes);
        const flags = JSON.parse(content) as Record<FeatureFlags, boolean>;
        return new FeatureFlagProvider(flags);
    }

    isEnabled(flagName: FeatureFlags): Promise<boolean> {
        return Promise.resolve(this.flags[flagName] ?? false);
    }
}
