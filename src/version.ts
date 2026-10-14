import pkg from '../package.json';

/** Product version. Single source of truth: the repository root package.json. */
export const VERSION: string = pkg.version;

/** SDK `appVersion` string: "platform-product@version" (two dash-separated parts). */
export const APP_VERSION = `external-drive-syncengine@${VERSION}`;
