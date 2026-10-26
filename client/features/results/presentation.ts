import type { ImageVersionSnapshot } from '../../../shared/material.js';
import type { ImagePresentation } from './ImageStage.js';
export function imagePresentation(image: ImageVersionSnapshot): ImagePresentation {
  return { assetId: image.assetId, contentVersion: image.contentVersion, name: image.metadata.name, role: image.role, width: image.width, height: image.height, provider: image.metadata.provider, sensorContext: image.metadata.sensorContext, illustrativeDate: image.origin.illustrativeDate };
}
export function imageKey(image: { assetId: string; contentVersion: number }): string { return `${image.assetId}:${image.contentVersion}`; }
