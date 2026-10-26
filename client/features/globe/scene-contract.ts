import type { Vec3 } from '../../../shared/globe.js';
import type { AreaCircle, AreaInteractionMode, AreaStrokeFeedback } from '../../../shared/area-proposal.js';
export type OrbitVisibility = 'all' | 'matches' | 'shortlist' | 'shortlist-only';
export interface GlobeTarget { latitude: number; longitude: number; radiusKm: number; confirmed?: boolean }
export interface DisplayTrack { id: string; name: string; position: Vec3; path?: Vec3[]; paths?: Vec3[][]; matched: boolean; shortlisted: boolean }
export function trackIsShown(item: Pick<DisplayTrack, 'id' | 'matched' | 'shortlisted'>, visibility: OrbitVisibility, selectedId: string | null): boolean {
  return visibility === 'all' || visibility === 'matches' && (item.matched || item.shortlisted) || visibility === 'shortlist' && (item.shortlisted || item.id === selectedId) || visibility === 'shortlist-only' && item.shortlisted;
}
export interface GlobeSceneState { objects: DisplayTrack[]; selectedId: string | null; target: GlobeTarget | null; visibility: OrbitVisibility; rotating: boolean; following: boolean; reducedMotion: boolean; followAnchor?: { x: number; y: number }; areaMode?: AreaInteractionMode; areaPreview?: AreaCircle | null }
export type GlobeHover = { kind: 'object'; id: string; x: number; y: number } | { kind: 'ground'; latitude: number; longitude: number; x: number; y: number };
export interface GlobeSceneCallbacks { canvasLabel?: string; onHover: (value: GlobeHover | null) => void; onSelect: (id: string) => void; onEarthPick?: (point: { latitude: number; longitude: number; radiusKm: 25 }) => void; onEarthClick?: () => void; onAreaStroke?: (value: AreaStrokeFeedback) => void; onAreaEscape?: () => void; onFatal: (reason: string) => void; onTexture: (status: 'ready' | 'unavailable') => void; onSelectedScreen: (value: { x: number; y: number } | null) => void; onReset: () => void; onToggleRotation: () => void }
export interface GlobeController { update: (state: GlobeSceneState) => void; reset: () => void; dispose: () => void }
