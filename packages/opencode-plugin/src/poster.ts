export async function postToLayman(
  baseUrl: string,
  eventName: string,
  payload: Record<string, unknown>
): Promise<unknown> {
  try {
    const response = await fetch(`${baseUrl}/hooks/${eventName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) return await response.json();
  } catch {
    // Layman may not be running — fail silently
  }
  return null;
}
