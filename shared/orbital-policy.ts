export const ORBITAL_POLICY_VERSION='coruscant-orbital-v1';
export const ORBITAL_PARSER_VERSION='coruscant-omm-v1';
export const ORBITAL_SOURCE_URLS={sar:'https://celestrak.org/NORAD/elements/gp.php?GROUP=sar&FORMAT=JSON',resource:'https://celestrak.org/NORAD/elements/gp.php?GROUP=resource&FORMAT=JSON'} as const;
export const ORBITAL_LIMITS=Object.freeze({sourceBytes:8*1024*1024,sourceRows:5000,unionObjects:10000,refreshMs:2*60*60*1000,sourceTimeoutMs:10000,catalogPage:100,positions:200,paths:50,browsePage:50,browseBytes:256*1024,browseDeadlineMs:10000,browseChunkObjects:20,yieldEvaluations:512,pathSeconds:90*60,pathCadenceSeconds:30,pathVertices:361,maxEpochAgeMs:24*60*60*1000,maxRetrievalAgeMs:24*60*60*1000,maxSpanMs:48*60*60*1000});
export function canonicalCatalogNumber(value:unknown):string|null {
  const text=typeof value==='number'&&Number.isSafeInteger(value)?String(value):typeof value==='string'?value.trim():'';
  if(!/^\d{1,9}$/.test(text))return null;
  const normalized=text.replace(/^0+(?=\d)/,'');return normalized==='0'?null:normalized;
}
export function canonicalRealId(value:unknown):string|null {const n=canonicalCatalogNumber(value);return n?`norad:${n}`:null;}
export function compareCatalogIds(a:string,b:string):number {
  const left=/^norad:(\d{1,9})$/.exec(a)?.[1],right=/^norad:(\d{1,9})$/.exec(b)?.[1];
  return left&&right?Number(left)-Number(right):a<b?-1:a>b?1:0;
}
export function orbitalFreshness(epoch:string|null,retrievedAt:string|null,calculatedAt:string,instants:readonly string[]=[]):string|null {
  const now=Date.parse(calculatedAt),e=Date.parse(epoch??''),r=Date.parse(retrievedAt??'');
  if(!Number.isFinite(now)||!Number.isFinite(e)||!Number.isFinite(r))return 'Orbit epoch or retrieval time is unavailable.';
  if(e>now)return 'Future orbit epoch is unsupported.';
  if(r>now)return 'Future retrieval time is unsupported.';
  if(now-e>ORBITAL_LIMITS.maxEpochAgeMs)return 'Orbit epoch is stale.';
  if(now-r>ORBITAL_LIMITS.maxRetrievalAgeMs)return 'Orbit source retrieval is stale.';
  if(instants.some(value=>!Number.isFinite(Date.parse(value))||Math.abs(Date.parse(value)-e)>ORBITAL_LIMITS.maxSpanMs))return 'Represented time or path is outside the supported epoch span.';
  return null;
}
