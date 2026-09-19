import type { RoomView } from '../src/shared/rooms.ts';

/** Invalidate on a save/unmount; only the latest read may update the panel. */
export async function loadLatestRoomView(
  request: { current: number },
  read: () => Promise<RoomView>,
  receive: (view: RoomView) => void,
  fail: (error: unknown) => void,
) {
  const id = ++request.current;
  try {
    const view = await read();
    if (id === request.current) receive(view);
  } catch (error) {
    if (id === request.current) fail(error);
  }
}
