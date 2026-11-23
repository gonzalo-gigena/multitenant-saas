import net from 'node:net';

// ponytail: just enough SMTP for Mailpit (no TLS, no AUTH), sent inside the request.
// Use the provider's HTTP API, from the worker, once real email exists (Phase 3).
export function sendMail(url, { from, to, subject, text }) {
  const { hostname, port } = new URL(url);
  const message = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '',
    text.replace(/^\./gm, '..'), '.'].join('\r\n');
  const commands = ['EHLO api', `MAIL FROM:<${from}>`, `RCPT TO:<${to}>`, 'DATA', message, 'QUIT'];
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port) || 25, hostname);
    sock.setEncoding('utf8');
    sock.setTimeout(5000, () => sock.destroy(new Error('smtp timeout')));
    sock.on('error', reject);
    let buf = '';
    let step = 0;
    sock.on('data', (chunk) => {
      buf += chunk;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line[3] === '-') continue; // a multi-line reply: wait for its last line
        if (Number(line.slice(0, 3)) >= 400) return sock.destroy(new Error(`smtp: ${line.trim()}`));
        if (step === commands.length) return sock.end(resolve);
        sock.write(`${commands[step++]}\r\n`);
      }
    });
  });
}
