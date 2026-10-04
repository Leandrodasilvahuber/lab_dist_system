import { escapeHtml } from '../core/format.js';

// headers: rótulos (string) ou { label, className, style }; rows: HTML de cada <tr>
export function dataTable(headers, rows) {
    const th = h => typeof h === 'string'
        ? `<th>${escapeHtml(h)}</th>`
        : `<th${h.className ? ` class="${h.className}"` : ''}${h.style ? ` style="${h.style}"` : ''}>${escapeHtml(h.label)}</th>`;
    const head = headers ? `<thead><tr>${headers.map(th).join('')}</tr></thead>` : '';
    return `<div class="table-wrap"><table class="data-table">${head}<tbody>${rows.join('')}</tbody></table></div>`;
}

// Clique numa linha tr.row-expandable (com data-index) abre/fecha o JSON
// completo logo abaixo. Botões dentro da linha têm a própria ação
export function expandableRows(container, entries) {
    container.addEventListener('click', event => {
        if (event.target.closest('button, [data-trace]')) return;
        const row = event.target.closest('tr.row-expandable');
        if (!row) return;
        if (row.nextElementSibling?.classList.contains('row-detail')) {
            row.nextElementSibling.remove();
            return;
        }
        const detail = document.createElement('tr');
        detail.className = 'row-detail';
        detail.innerHTML = `<td colspan="${row.cells.length}"><pre class="code">${escapeHtml(JSON.stringify(entries()[row.dataset.index], null, 2))}</pre></td>`;
        row.after(detail);
    });
}
