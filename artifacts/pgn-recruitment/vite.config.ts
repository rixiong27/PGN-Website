import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    'PORT environment variable is required but was not provided.',
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    'BASE_PATH environment variable is required but was not provided.',
  );
}

const browserTestAuth = process.env.PGN_BROWSER_TEST_AUTH === 'true';

const browserTestPlugin = browserTestAuth
  ? {
      name: 'pgn-browser-test-fixtures',
      enforce: 'pre' as const,
      transform(source: string, id: string) {
        if (!id.endsWith('/src/App.tsx')) return undefined;
        const testDouble = `/@fs${path.resolve(import.meta.dirname, 'test', 'clerk-test-double.tsx')}`;
        return source
          .replaceAll("'@clerk/react/internal'", `'${testDouble}'`)
          .replaceAll('"@clerk/react/internal"', `"${testDouble}"`);
      },
      configureServer(server: {
        middlewares: {
          use: (
            path: string,
            handler: (
              request: { url?: string; method?: string },
              response: {
                statusCode: number;
                setHeader: (name: string, value: string) => void;
                end: (body: string) => void;
              },
              next: () => void,
            ) => void,
          ) => void;
        }
      }) {
        server.middlewares.use('/api', (request, response, next) => {
          if (request.method !== 'GET') {
            next();
            return;
          }

          const mountedPathname = new URL(request.url ?? '/', 'http://browser-test').pathname;
          const pathname = mountedPathname.startsWith('/api/')
            ? mountedPathname
            : `/api${mountedPathname}`;
          const member = {
            id: 1,
            name: 'Browser Test Member',
            email: 'browser-test@example.com',
            role: 'admin',
            status: 'approved',
            createdAt: '2026-09-16T00:00:00.000Z',
          };
          const pnm = {
            id: 42,
            firstName: 'Browser',
            lastName: 'Test',
            pronouns: null,
            email: 'browser-test@example.com',
            year: 'Senior',
            major: 'Computer Science',
            minor: null,
            gpa: null,
            semester: 'Fall 2026',
            status: 'new',
            photoPath: null,
            averageVote: null,
            voteCount: 0,
            createdAt: '2026-09-16T00:00:00.000Z',
            updatedAt: '2026-09-16T00:00:00.000Z',
          };
          let body: unknown = [];

          if (pathname === '/api/me') body = member;
          else if (pathname === '/api/dashboard') {
            body = {
              totalPnms: 1,
              activePnms: 1,
              pendingApprovals: 0,
              outstandingVotes: 0,
              pipeline: [],
              openRounds: [],
            };
          } else if (pathname === '/api/pnms/42') body = pnm;
          else if (pathname === '/api/notes/42') body = [];

          response.statusCode = 200;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(body));
        });
      },
    }
  : null;

export default defineConfig({
  base: basePath,
  plugins: [
    // This app currently keeps its route components in one module. Full reloads
    // avoid stale hook signatures when that module changes during development.
    react({ fastRefresh: false }),
    tailwindcss({ optimize: false }),
    runtimeErrorOverlay(),
    browserTestPlugin,
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      ...(browserTestAuth
        ? {
            '@clerk/react': path.resolve(
              import.meta.dirname,
              'test',
              'clerk-test-double.tsx',
            ),
          }
        : {}),
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
