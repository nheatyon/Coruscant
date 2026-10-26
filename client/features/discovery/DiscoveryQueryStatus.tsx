import type { ReactNode } from 'react';

export type DiscoveryQueryPhase = 'initial' | 'loading' | 'reading' | 'stale' | 'review' | 'complete' | 'empty' | 'failure' | 'planned';

export function DiscoveryQueryStatus({ phase, message, countLabel, unknownCount, shortlistCount, viewMatches, viewShortlist, matchesUnavailable, targetContext }: {
  phase: DiscoveryQueryPhase; message: string; countLabel: string; unknownCount: number; shortlistCount: number;
  viewMatches: () => void; viewShortlist: () => void; matchesUnavailable: boolean;
  targetContext?: ReactNode;
}) {
  return <section className="discovery-query-strip" aria-label="Discovery query results" data-query-phase={phase}>
    <div className="query-result-copy" role="status" aria-live="polite" aria-atomic="true">
      <p className="query-result-state">{message}</p>
      <p className="query-result-counts"><strong>{countLabel}</strong><span>{shortlistCount} shortlisted</span>{unknownCount > 0 && <span>Includes {unknownCount} with unrecorded evidence</span>}</p>
      {targetContext}
    </div>
    <div className="query-result-actions"><button className="button" disabled={matchesUnavailable} onClick={viewMatches}>View matches</button><button className="button" onClick={viewShortlist}>View shortlist</button></div>
  </section>;
}
