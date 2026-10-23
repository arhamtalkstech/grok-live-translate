import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A tiny in-memory bank API for the Agent builder tab, so its tools make real HTTP calls
 * without any external system. Every name and email here is made up; emails use the
 * reserved example.com/example.org domains.
 *
 *   GET  /mock-bank/users?email=…     → [] or [user]
 *   POST /mock-bank/cases             → the created case
 *   GET  /mock-bank/cases             → all cases created since the server started
 *   POST /mock-bank/insights          → a qualitative note about a client
 */

type User = {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  client_id: string;
  login_id: string;
  password_admin: boolean;
  lending_access: boolean;
};

const USERS: User[] = [
  { id: 1, first_name: 'Daniel', last_name: 'Okafor', email: 'd.okafor16@example.com', client_id: 'C004', login_id: 'DOKAFOR16', password_admin: true, lending_access: true },
  { id: 2, first_name: 'Lena', last_name: 'Hartmann', email: 'l.hartmann@example.com', client_id: 'C019', login_id: 'LHARTMANN', password_admin: true, lending_access: true },
  { id: 3, first_name: 'Marco', last_name: 'Rinaldi', email: 'marco.rinaldi@example.org', client_id: 'C019', login_id: 'MRINALDI', password_admin: true, lending_access: false },
  { id: 4, first_name: 'Ewa', last_name: 'Kowalska', email: 'ewa.kowalska@example.com', client_id: 'C011', login_id: 'EKOWALSKA', password_admin: true, lending_access: true },
  { id: 5, first_name: 'Rahul', last_name: 'Sharma', email: 'rahul.sharma@example.com', client_id: 'C007', login_id: 'RSHARMA', password_admin: false, lending_access: true },
];

const INSIGHTS: Record<string, string> = {
  C004: 'Long-standing client with moderate use of existing facilities.',
  C019: 'Growing client; current facilities are well used and in good standing. A larger working-capital line would need a relationship manager review.',
  C011: 'Stable client with low utilisation of existing lines.',
  C007: 'Newer client; any new facility needs a full credit review.',
};

const cases: Record<string, unknown>[] = [];

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    return {};
  }
}

/** Returns true when the request was handled. */
export async function handleMockBank(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/mock-bank/')) return false;
  const path = url.pathname.slice('/mock-bank'.length);
  if (path === '/users' && req.method === 'GET') {
    const email = (url.searchParams.get('email') ?? '').trim().toLowerCase();
    send(res, 200, USERS.filter(u => u.email === email));
    return true;
  }
  if (path === '/cases' && req.method === 'POST') {
    const body = await readJson(req);
    const created = { ...body, caseId: randomUUID(), createdDate: new Date().toISOString(), id: cases.length + 1 };
    cases.push(created);
    send(res, 200, created);
    return true;
  }
  if (path === '/cases' && req.method === 'GET') {
    send(res, 200, cases);
    return true;
  }
  if (path === '/insights' && req.method === 'POST') {
    const body = await readJson(req);
    const note = INSIGHTS[String(body.client_id ?? '')];
    send(res, note ? 200 : 404, note ? { client_id: body.client_id, answer: note } : { error: 'client not found' });
    return true;
  }
  send(res, 404, { error: 'not found' });
  return true;
}
