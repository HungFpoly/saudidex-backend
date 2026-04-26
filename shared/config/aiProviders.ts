import { isGeminiConfigured } from './runtime';

export type AIProvider = 'gemini' | 'webllm' | 'groq' | 'openrouter' | 'mistral' | 'huggingface';

export interface ProviderConfig {
  id: AIProvider;
  name: string;
  mode: 'client' | 'backend';
  enabled: boolean;
  strengths: string[];
  recommendedWorkloads: string[];
  models: string[];
  discoveryModel: string;
  enrichmentModel: string;
  researchModel: string;
}

export const AI_PROVIDERS: ProviderConfig[] = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    mode: 'backend',
    enabled: isGeminiConfigured(),
    strengths: ['Multimodal', 'Large context window', 'Native URL context', 'High speed'],
    recommendedWorkloads: ['Discovery', 'Enrichment', 'Complex reasoning'],
    models: ['gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'],
    discoveryModel: 'gemini-3-flash-preview',
    enrichmentModel: 'gemini-3-flash-preview',
    researchModel: 'gemini-3-flash-preview'
  },
  {
    id: 'webllm',
    name: 'WebLLM (Browser)',
    mode: 'client',
    enabled: true, // Runs locally via WebGPU — no API key needed
    strengths: ['Zero latency', 'Offline capable', 'No API cost', 'Privacy-first'],
    recommendedWorkloads: ['Research queries', 'Text classification', 'Simple extraction'],
    models: ['Llama-3.1-8B-Instruct-q4f32_1-MLC'],
    discoveryModel: 'Llama-3.1-8B-Instruct-q4f32_1-MLC',
    enrichmentModel: 'Llama-3.1-8B-Instruct-q4f32_1-MLC',
    researchModel: 'Llama-3.1-8B-Instruct-q4f32_1-MLC'
  },
  {
    id: 'groq',
    name: 'Groq (Llama 3)',
    mode: 'backend',
    enabled: true, // Managed by backend
    strengths: ['Extreme low latency', 'High throughput'],
    recommendedWorkloads: ['Fast classification', 'Simple extraction'],
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    discoveryModel: 'llama-3.3-70b-versatile',
    enrichmentModel: 'llama-3.3-70b-versatile',
    researchModel: 'llama-3.3-70b-versatile'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    mode: 'backend',
    enabled: true,
    strengths: ['Access to any model', 'Unified API'],
    recommendedWorkloads: ['Fallback', 'Specialized models'],
    models: ['google/gemini-pro-1.5', 'mistralai/mistral-7b-instruct:free'],
    discoveryModel: 'google/gemini-pro-1.5',
    enrichmentModel: 'google/gemini-pro-1.5',
    researchModel: 'google/gemini-pro-1.5'
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    mode: 'backend',
    enabled: true,
    strengths: ['Open weights', 'Strong reasoning'],
    recommendedWorkloads: ['Enrichment', 'Translation'],
    models: ['mistral-large-latest', 'mistral-small-latest'],
    discoveryModel: 'mistral-small-latest',
    enrichmentModel: 'mistral-large-latest',
    researchModel: 'mistral-small-latest'
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    mode: 'backend',
    enabled: true,
    strengths: ['Open source models', 'High flexibility'],
    recommendedWorkloads: ['Specialized tasks', 'Research'],
    models: ['meta-llama/Llama-3.3-70B-Instruct'],
    discoveryModel: 'meta-llama/Llama-3.3-70B-Instruct',
    enrichmentModel: 'meta-llama/Llama-3.3-70B-Instruct',
    researchModel: 'meta-llama/Llama-3.3-70B-Instruct'
  }
];

export const getProvider = (id: AIProvider) => AI_PROVIDERS.find(p => p.id === id);

export const isProviderEnabled = (id: AIProvider) => {
  const p = getProvider(id);
  return p ? p.enabled : false;
};

export type WorkloadType = 'discovery' | 'enrichment' | 'research';

export const FALLBACK_CHAINS: Record<WorkloadType, AIProvider[]> = {
  discovery: ['gemini', 'webllm', 'openrouter', 'groq'],
  enrichment: ['gemini', 'webllm', 'mistral', 'openrouter'],
  research: ['gemini', 'webllm', 'openrouter']
};
