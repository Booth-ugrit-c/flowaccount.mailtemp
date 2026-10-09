import { createHash } from "node:crypto";

export interface AttachmentInfo {
  name: string;
  size: number;
  sha256: string;
}

export interface CapturedMessage {
  id: string;
  subject: string;
  created: Date;
  to: string[];
  attachments: AttachmentInfo[];
  raw: Buffer;
}

export interface WaitOptions {
  receivedAfter: Date;
  timeoutMs: number;
  pollIntervalMs?: number;
  baseUrl?: string;
  user?: string;
  password?: string;
}

export class MailboxTimeoutError extends Error {
  constructor(testId: string, timeoutMs: number, receivedAfter: Date) {
    super(`No message tagged "${testId}" received after ${receivedAfter.toISOString()} within ${timeoutMs} ms`);
    this.name = "MailboxTimeoutError";
  }
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function client(options: WaitOptions) {
  const baseUrl = options.baseUrl ?? process.env.MAILPIT_API_URL ?? "http://127.0.0.1:8025/admin";
  const user = options.user ?? process.env.MAILPIT_USER;
  const password = options.password ?? process.env.MAILPIT_PASSWORD;
  const headers: Record<string, string> = {};
  if (user && password) headers.Authorization = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
  return async (path: string) => {
    const res = await fetch(baseUrl + path, { headers });
    if (!res.ok) throw new Error(`Mailpit ${path} returned ${res.status}`);
    return res;
  };
}

export async function waitForMessage(testId: string, options: WaitOptions): Promise<CapturedMessage> {
  const get = client(options);
  const deadline = Date.now() + options.timeoutMs;
  const interval = options.pollIntervalMs ?? 500;

  for (;;) {
    const search = await (await get(`/api/v1/search?query=${encodeURIComponent(`tag:${testId}`)}`)).json();
    const fresh = (search.messages as { ID: string; Created: string }[])
      .filter((m) => new Date(m.Created) >= options.receivedAfter)
      .sort((a, b) => b.Created.localeCompare(a.Created));
    if (fresh.length > 0) return load(get, fresh[0].ID);
    if (Date.now() >= deadline) throw new MailboxTimeoutError(testId, options.timeoutMs, options.receivedAfter);
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
  }
}

async function load(get: (path: string) => Promise<Response>, id: string): Promise<CapturedMessage> {
  const detail = await (await get(`/api/v1/message/${id}`)).json();
  const raw = Buffer.from(await (await get(`/api/v1/message/${id}/raw`)).arrayBuffer());
  const attachments: AttachmentInfo[] = [];
  for (const part of detail.Attachments as { PartID: string; FileName: string; Size: number }[]) {
    const bytes = Buffer.from(await (await get(`/api/v1/message/${id}/part/${part.PartID}`)).arrayBuffer());
    attachments.push({ name: part.FileName, size: bytes.length, sha256: sha256(bytes) });
  }
  return {
    id,
    subject: detail.Subject,
    created: new Date(detail.Date ?? detail.Created),
    to: (detail.To as { Address: string }[]).map((a) => a.Address),
    attachments,
    raw,
  };
}
