import { createContext } from 'react';
import type { SurfaceRequest } from '../bridge';

/**
 * Opens a native window for a session, the audit log, Customize or Launch
 * (#223). Rejects when there is none (outside the app, a snapshot, an older
 * shell); the caller then shows its in-window view, as before.
 */
export type OpenSurface = (request: SurfaceRequest) => Promise<void>;

/** Given by the popup and the native surfaces; null keeps every view in its own window. */
export const SurfaceOpenerContext = createContext<OpenSurface | null>(null);
