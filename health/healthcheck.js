import http from 'http';

const url = 'http://127.0.0.1:3000/graphene-mpt/health/ready';
const timeoutMs = 5000;

const timeout = setTimeout(() => process.exit(1), timeoutMs);

http.get(url, res => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
        clearTimeout(timeout);
        try {
            const j = JSON.parse(body);
            process.exit(j && j.status === 'UP' ? 0 : 1);
        } catch (e) {
            process.exit(1);
        }
    });
}).on('error', () => process.exit(1));