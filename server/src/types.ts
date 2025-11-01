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

export interface EntitySubject {
  name: string;
  type: string;
  canonical_id: string;
}

export interface MagicVariableValue<T = unknown> {
  subject: EntitySubject;
  name: string;
  type: MagicVariableType;
  value: T;
  confidence: number; 
  sources: SourceAttribution[];
  observed_at?: string; 
}

export interface EnrichmentResult {
  intent: 'boolean' | 'specific' | 'contextual';
  variables: MagicVariableValue[];
  notes?: string;
}


