/**
 * The account menu asks for the "Getting started" guide back with this
 * window event (`getting-started.tsx` listens). A module of its own so the
 * sidebar, which is in the shell's first paint, can name the event without
 * pulling the guide's steps and copy into that chunk.
 */
export const OPEN_GUIDE_EVENT = "bcontext:getting-started";
