// src/app/[locale]/(admin)/allocation/extraction/actions.ts
'use server';

import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { runFeatureExtraction } from '@/lib/allocation/run-extraction';
import { extractionRuleSchema, idSchema } from '@/lib/validation/allocation';

export async function triggerFeatureExtraction() {
  const { userId, service } = await requireAgendaStaffCaller();
  const result = await runFeatureExtraction(service, userId);
  await writeAuditLog(service, {
    entityType: 'feature_extraction_run',
    entityId: result.id,
    action: 'run',
    actorId: userId,
    metadata: { applicationCount: result.applicationCount },
  });
  return result;
}

export async function createExtractionRule(input: unknown) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = extractionRuleSchema.parse(input);

  const { data: existing } = await service
    .from('feature_extraction_rules')
    .select('version')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = (existing?.version ?? 0) + 1;

  const { data, error } = await service
    .from('feature_extraction_rules')
    .insert({
      version: nextVersion,
      source_field: parsed.sourceField,
      match_type: parsed.matchType,
      match_value: parsed.matchValue,
      tag_id: parsed.tagId,
      weight: parsed.weight,
      updated_by: userId,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create extraction rule: ${error?.message}`);

  await writeAuditLog(service, { entityType: 'feature_extraction_rule', entityId: data.id, action: 'create', actorId: userId, newValues: parsed });
  return { id: data.id };
}

export async function deactivateExtractionRule(ruleId: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsedRuleId = idSchema.parse(ruleId);
  const { error } = await service.from('feature_extraction_rules').update({ is_active: false, updated_by: userId }).eq('id', parsedRuleId);
  if (error) throw new Error(`Failed to deactivate extraction rule: ${error.message}`);
  await writeAuditLog(service, { entityType: 'feature_extraction_rule', entityId: parsedRuleId, action: 'deactivate', actorId: userId });
}
