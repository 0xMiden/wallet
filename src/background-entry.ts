/**
 * Background entry point for the Vite build.
 *
 * When using sw.js + importScripts (non-module SW), this file is the
 * entry point that Vite builds into background.js. The sw.js wrapper
 * loads it via importScripts('background.js').
 *
 * MV3 listeners (onInstalled, onConnect, onMessage) are registered
 * in sw.js BEFORE importScripts, ensuring they fire synchronously.
 */
import { Buffer } from 'buffer';
(globalThis as any).Buffer = (globalThis as any).Buffer || Buffer;

import './background';
