/**
 * Push one alert to the owner's phone through ntfy (the same `NTFY_TOPIC` the
 * server alerters use). A no-op when the topic is unset; never throws.
 */
export async function sendPhoneAlert(title: string, message: string): Promise<void> {
  const topic = process.env['NTFY_TOPIC']?.trim();
  if (!topic) return;
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: title, Priority: 'high', Tags: 'warning' },
      body: message,
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error('phone alert failed:', err instanceof Error ? err.message : err);
  }
}
