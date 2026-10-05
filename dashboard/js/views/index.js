import admin from './admin.js';
import buy from './buy.js';
import chaos from './chaos.js';
import dlq from './dlq.js';
import logs from './logs.js';
import metrics from './metrics.js';
import monitoring from './monitoring.js';
import orders from './orders.js';
import performance from './performance.js';
import products from './products.js';
import resources from './resources.js';
import slo from './slo.js';
import stock from './stock.js';
import summary from './summary.js';
import trace from './trace.js';

// Navegação agrupada por assunto. Cada tela é um módulo com
// { id, label, icon, template(), mount?(), refresh?(), requiresAdmin? }.
// Para uma tela nova: crie o módulo e acrescente-o ao grupo aqui
export const GROUPS = [
    { id: 'store', label: 'Loja', views: [buy, products, stock, orders, summary] },
    { id: 'observe', label: 'Observabilidade', views: [monitoring, metrics, logs, trace, performance, slo, resources] },
    { id: 'ops', label: 'Operação', views: [dlq, chaos, admin] }
];

export const DEFAULT_VIEW = 'buy';
