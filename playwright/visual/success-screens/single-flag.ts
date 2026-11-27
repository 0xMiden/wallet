// Imported first by the single-file entry. The HTML sets the mode before the script runs; with none
// set, the file is the Send flow by itself.
const scope = globalThis as { __BREAD_SINGLE__?: string };
scope.__BREAD_SINGLE__ ??= 'flow';
