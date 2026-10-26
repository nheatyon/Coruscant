import { createHash } from 'node:crypto';
import { comparisonDates } from '../catalog.js';

export const SCENE_RECIPE_VERSION = 'estuary-scenes-v1';
export const SCENE_WIDTH = 1600;
export const SCENE_HEIGHT = 1000;

export interface SceneAsset {
  id: string;
  role: 'BASELINE' | 'RECENT';
  contentVersion: number;
  filename: string;
  content: string;
  sha256: string;
  illustrativeDate: string;
  recipeVersion: string;
  width: number;
  height: number;
  name: string;
  source: string;
  provider: string;
  sensorContext: string;
  actualCollection: null;
  demonstration: true;
  permittedUse: string;
}

function estuaryScene(role: 'BASELINE' | 'RECENT', date: string): string {
  const recent = role === 'RECENT';
  const label = recent ? 'RECENT' : 'BASELINE';
  const mainChannel = 'M642 90 C608 161 728 208 684 279 C631 362 773 384 748 459 C718 530 833 557 878 606 C943 679 948 743 1069 799 C1186 853 1335 851 1537 954 L1600 1000 L1110 1000 C1026 894 873 872 813 777 C746 671 684 644 670 547 C653 445 581 423 600 340 C623 253 520 225 567 143 Z';
  const expanded = 'M608 94 C555 145 650 179 607 229 L541 269 L584 322 C543 379 631 400 622 448 L573 487 L641 545 C623 601 743 614 759 681 L697 734 L782 799 L764 850 C876 887 949 929 1008 1000 L1600 1000 L1554 920 C1422 858 1343 807 1253 805 L1194 756 L1104 753 C1038 722 1029 657 969 628 L1014 569 L926 545 L883 484 L808 465 C820 410 732 381 737 329 L796 295 L732 245 C756 177 670 158 694 94 Z';
  const tributary = 'M1030 160 C983 236 1020 318 949 388 C902 435 856 460 825 520 L862 547 C887 476 957 470 1001 405 C1066 306 1034 239 1084 181 Z';
  const fields = [
    'M82 176L302 124L365 249L150 304Z', 'M147 338L379 283L438 413L188 463Z',
    'M68 505L288 477L361 619L129 670Z', 'M211 705L431 651L508 790L292 849Z',
    'M1161 164L1413 202L1387 343L1144 306Z', 'M1197 385L1490 425L1451 552L1168 516Z',
    'M122 126L134 157L335 104L327 76Z', 'M356 477L516 437L572 563L414 611Z',
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000" role="img" aria-labelledby="title description">
<title id="title">Fictional estuary — ${label.toLowerCase()} synthetic demonstration</title>
<desc id="description">Original vector illustration of a fictional estuary. ${recent ? 'A larger dark region contiguous with the river illustrates a possible visual difference.' : 'A narrower dark river provides the illustrative baseline.'} This is not collected imagery, measured radar data, flood detection or an image of the requested real location.</desc>
<metadata>Recipe ${SCENE_RECIPE_VERSION}; illustrative ${label.toLowerCase()} date ${date}; actual collection: null; newly authored Coruscant demonstration material; not georeferenced.</metadata>
<defs>
  <filter id="land-grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.18" numOctaves="2" seed="73"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0.13"/></feComponentTransfer></filter>
  <pattern id="survey-grid" width="100" height="100" patternUnits="userSpaceOnUse"><path d="M100 0H0V100" fill="none" stroke="#e3e3dd" stroke-opacity="0.045" stroke-width="1"/></pattern>
</defs>
<rect width="1600" height="1000" fill="#555852"/>
<path d="M0 160L303 80L484 177L529 345L443 518L512 711L631 832L489 1000H0Z" fill="#62645e"/>
<path d="M828 0H1600V751L1439 705L1328 586L1139 546L1091 352L905 270Z" fill="#686b64"/>
<g fill="#7a7c72" fill-opacity="0.62" stroke="#a4a69c" stroke-opacity="0.28" stroke-width="2">${fields.map((path) => `<path d="${path}"/>`).join('')}</g>
<g fill="none" stroke="#96988f" stroke-width="7" stroke-opacity="0.54"><path d="M0 377C231 356 362 179 497 229S815 269 974 138S1253 98 1600 242"/><path d="M94 1000C228 855 402 788 523 813S767 929 833 1000"/><path d="M1214 0C1219 239 1130 378 1200 582S1411 715 1600 724"/></g>
<rect width="1600" height="1000" filter="url(#land-grain)" opacity="0.8"/>
${recent ? `<path d="${expanded}" fill="#202723"/>` : ''}
<path d="${mainChannel}" fill="#171d1a"/>
<path d="${tributary}" fill="#252d27"/>
<path d="M912 718C970 749 988 791 1067 817S1261 858 1398 907" fill="none" stroke="#777d71" stroke-width="3" stroke-opacity="0.42"/>
<path d="M1020 861L1098 876L1136 916L1077 924L1039 902Z" fill="#6c7065"/>
<path d="M1252 897L1312 906L1356 939L1292 954L1257 933Z" fill="#656a60"/>
<rect width="1600" height="1000" fill="url(#survey-grid)"/>
<rect x="0" y="0" width="1600" height="90" fill="#080b09"/>
<text x="40" y="35" fill="#dce0d7" font-family="monospace" font-size="16" letter-spacing="2">FICTIONAL ESTUARY / ${label}</text>
<text x="40" y="65" fill="#aeb7a9" font-family="monospace" font-size="15">ILLUSTRATIVE ${label} DATE / ${date}</text>
<rect x="0" y="954" width="1600" height="46" fill="#080b09"/>
<text x="40" y="982" fill="#d0d7c9" font-family="monospace" font-size="14" letter-spacing="1">SYNTHETIC DEMONSTRATION · NOT COLLECTED · NOT MEASURED RADAR · NO GEOREFERENCE</text>
</svg>
`;
}

/** Original recipes only: this performs no publication, review, entitlement or delivery. */
export function sceneAssets(d0: string): SceneAsset[] {
  const dates = comparisonDates(d0);
  return (['BASELINE', 'RECENT'] as const).map((role) => {
    const baseline = role === 'BASELINE';
    const illustrativeDate = baseline ? dates.baselineDate : dates.recentDate;
    const content = estuaryScene(role, illustrativeDate);
    return {
      id: baseline ? 'demo-estuary-baseline' : 'demo-estuary-recent',
      role,
      contentVersion: 1,
      filename: baseline ? 'estuary-baseline-v1.svg' : 'estuary-recent-v1.svg',
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      illustrativeDate,
      recipeVersion: SCENE_RECIPE_VERSION,
      width: SCENE_WIDTH,
      height: SCENE_HEIGHT,
      name: baseline ? 'Fictional estuary — Baseline' : 'Fictional estuary — Recent',
      source: 'Coruscant original synthetic estuary scene v1',
      provider: 'Coruscant demonstration material',
      sensorContext: 'Synthetic illustration of a SAR request — not radar observations',
      actualCollection: null,
      demonstration: true,
      permittedUse: 'Local Coruscant testing and demonstration; synthetic illustration, not actual Earth observations.',
    };
  });
}
