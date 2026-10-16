import { stageManagedTlsDelivery } from '../../../packages/shared/runtime/managed-tls-delivery.mjs';

process.env.NODE_ENV ??= 'production';

stageManagedTlsDelivery('api');
await import('./server.js');

export {};
