import type { RequestProjection } from '../../../shared/contracts.js';
import type { MaterialCommandName, MaterialExpected, MaterialPayloads, MaterialTarget, StaffResultProjection } from '../../../shared/material.js';
import { useWorkflow } from '../workflow/useWorkflow.js';
import type { WorkflowPayloads } from '../../../shared/workflow.js';

export function materialStamp(result: StaffResultProjection | null): string {
  return result ? [result.id, result.materialVersion, result.access?.version ?? 0, ...result.images.map(image => `${image.id}:${image.currentVersion?.contentVersion}:${image.approval?.id}:${image.state}`), result.finding?.currentVersion.contentVersion ?? 0, result.finding?.review?.id ?? '', result.finding?.state ?? ''].join(':') : 'no-result';
}
export function useMaterialAction<T>(request: RequestProjection, result: StaffResultProjection | null, slot: string, initial: T, saved: (text: string) => void) {
  const form = useWorkflow(request, `material:${slot}`, initial, saved, materialStamp(result));
  const binding = (target?: Omit<MaterialTarget, 'requestId'>, expected?: MaterialExpected) => ({ target: { ...(result ? { resultId: result.id } : {}), ...target }, expected: { ...(result ? { materialVersion: result.materialVersion } : {}), ...expected } });
  return { ...form,
    previewAction: <K extends MaterialCommandName>(name: K, payload: MaterialPayloads[K], target?: Omit<MaterialTarget, 'requestId'>, expected?: MaterialExpected) => form.review<K>(name, payload as WorkflowPayloads[K], undefined, undefined, binding(target, expected)),
    commitAction: <K extends MaterialCommandName>(name: K, payload: MaterialPayloads[K], target?: Omit<MaterialTarget, 'requestId'>, expected?: MaterialExpected, direct = false) => form.execute<K>(name, payload as WorkflowPayloads[K], { ...binding(target, expected), direct }),
  };
}
