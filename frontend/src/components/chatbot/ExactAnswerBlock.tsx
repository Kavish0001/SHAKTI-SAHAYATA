import React from 'react';
import type { ChatAnswerPayload } from './GroundedAnswerCard';
import { renderRichMessage } from './chatRichText';

type ExactAnswerBlockProps = {
  payload: ChatAnswerPayload;
  dark: boolean;
};

const labelize = (value: string) =>
  value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());

const tableClass = (dark: boolean) =>
  dark
    ? 'border-white/10 bg-slate-950/40 text-slate-100'
    : 'border-slate-200 bg-white text-slate-800';

const mutedClass = (dark: boolean) =>
  dark ? 'text-slate-400' : 'text-slate-500';

const ExactAnswerBlock: React.FC<ExactAnswerBlockProps> = ({ payload, dark }) => {
  const evidence = Array.isArray(payload.evidence) ? payload.evidence[0] : null;
  const columns = Array.isArray(evidence?.columns) ? evidence.columns : [];
  const rows = Array.isArray(evidence?.previewRows) ? evidence.previewRows : (Array.isArray(evidence?.rows) ? evidence.rows : []);
  const provenance = payload.debugMeta?.provenance as Record<string, unknown> | undefined;
  const freshness = payload.debugMeta?.freshness as Record<string, unknown> | undefined;
  const reasonCode = typeof payload.debugMeta?.reasonCode === 'string' ? payload.debugMeta.reasonCode : null;

  return (
    <div className="mt-1">
      {payload.shortAnswer ? (
        <div className="space-y-2">
          {renderRichMessage(payload.shortAnswer)}
        </div>
      ) : null}

      {columns.length > 0 && rows.length > 0 ? (
        <div className={`mt-3 overflow-x-auto rounded-xl border ${tableClass(dark)}`}>
          <table className="min-w-full text-left text-sm">
            <thead className={dark ? 'bg-slate-900/80' : 'bg-slate-50'}>
              <tr>
                {columns.map((column) => (
                  <th key={column.key} className="px-3 py-2 font-semibold">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`exact-row-${rowIndex}`} className={dark ? 'border-t border-white/10' : 'border-t border-slate-200'}>
                  {columns.map((column) => (
                    <td key={`${rowIndex}-${column.key}`} className="px-3 py-2 align-top">
                      {String(row[column.key] ?? '-')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className={`mt-3 text-[11px] ${mutedClass(dark)}`}>
        {provenance?.source ? <span>Source: {String(provenance.source)}</span> : null}
        {freshness?.computedAt ? <span>{provenance?.source ? ' • ' : ''}Freshness: {String(freshness.computedAt)}</span> : null}
        {reasonCode ? <span>{provenance?.source || freshness?.computedAt ? ' • ' : ''}Reason: {labelize(reasonCode)}</span> : null}
      </div>
    </div>
  );
};

export default ExactAnswerBlock;
