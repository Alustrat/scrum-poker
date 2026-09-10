export async function createRoom(name: string, password: string): Promise<{ id: string }> {
  const res = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password: password || undefined }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? 'Failed to create room');
  }
  return res.json();
}

export async function getRoomInfo(
  id: string
): Promise<{ id: string; name: string; hasPassword: boolean }> {
  const res = await fetch(`/api/rooms/${id}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? 'Room not found');
  }
  return res.json();
}
