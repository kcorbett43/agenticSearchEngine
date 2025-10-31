export type MagicVariableType = 'boolean' | 'string' | 'number' | 'date' | 'url' | 'text';

export interface MagicVariableDefinition {
  name: string;
  type?: MagicVariableType;
  description?: string;
}

export interface SourceAttribution {
  title?: string;
  url: string;
  snippet?: string;
}

export interface MagicVariableValue<T = unknown> {
  name: string;
  type: MagicVariableType;
  value: T;
  confidence: number; // 0..1
  sources: SourceAttribution[];
}

export interface EnrichmentResult {
  intent: 'boolean' | 'specific' | 'contextual';
  variables: MagicVariableValue[];
  notes?: string;
}


