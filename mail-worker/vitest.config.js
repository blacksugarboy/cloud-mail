import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		include: ['test/**/*.test.js'],
		testTimeout: 30000,
		hookTimeout: 30000,
		onConsoleLog(log) {
			if (log.startsWith('跳过')) return false;
		},
		poolOptions: {
			workers: {
				main: './src/index.js',
				singleWorker: true,
				// Isolated, in-memory bindings: never use deployed D1/KV resources.
				miniflare: {
					compatibilityDate: '2025-06-04',
					compatibilityFlags: ['nodejs_compat'],
					d1Databases: ['db'],
					kvNamespaces: ['kv'],
					bindings: {
						domain: ['example.com'],
						admin: 'admin@example.com',
						jwt_secret: 'local-regression-secret-not-for-production',
						orm_log: false,
						analysis_cache: false
					}
				},
			},
		},
	},
});
