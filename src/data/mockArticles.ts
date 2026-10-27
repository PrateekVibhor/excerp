import type { Article } from './types';

// Mock content only. Titles are generic and do not describe specific real
// announcements; source URLs are each company's landing page, not article paths.
const FETCHED_AT = '2026-10-03T08:00:00Z';

export const mockArticles: Article[] = [
  {
    id: 'mock-1',
    source_company: 'NVIDIA',
    source_url: 'https://research.nvidia.com/',
    content_type: 'Research Paper',
    title: 'Memory-Efficient Training for Long-Context Models',
    summary:
      'The paper examines techniques for reducing accelerator memory use when training language models on long input sequences. It compares activation checkpointing, sequence parallelism and mixed-precision schedules across several model sizes. Reported results show lower peak memory with a modest throughput cost, and the authors discuss which combinations suit different hardware configurations and sequence lengths.',
    published_at: '2026-09-29T09:00:00Z',
    fetched_at: FETCHED_AT,
    reader_count: 128,
    topic: 'Research',
    quiz: {
      questions: [
        { prompt: 'What problem does the paper address?', options: ['Slow inference when serving short prompts to many users','Reducing accelerator memory use when training on long sequences','The cost of labeling large amounts of training data','Network latency between distant data centers'], correct_index: 1 },
        { prompt: 'Which techniques does the paper compare?', options: ['Activation checkpointing, sequence parallelism and mixed-precision schedules','Quantization, pruning, distillation and low-rank adapters','Dropout, weight decay, label smoothing and data augmentation','Caching, batching, speculative decoding and kernel fusion'], correct_index: 0 },
        { prompt: 'What do the reported results show?', options: ['Higher accuracy at the same memory','Much higher throughput with no trade-off','Lower peak memory with a modest throughput cost','No change in memory use'], correct_index: 2 },
      ],
    },
  },
  {
    id: 'mock-2',
    source_company: 'Google',
    source_url: 'https://research.google/',
    content_type: 'White Paper',
    title: 'A Practical Guide to Evaluating Generative AI Systems',
    summary:
      'This white paper outlines a framework for evaluating generative AI systems before deployment. It covers defining task-specific metrics, building representative test sets, running human review, and tracking regressions after updates. The authors recommend combining automated scoring with periodic expert audits, and they list common pitfalls such as leaked test data and overly narrow benchmarks.',
    published_at: '2026-09-28T14:30:00Z',
    fetched_at: FETCHED_AT,
    reader_count: 94,
    topic: 'Generative AI',
    quiz: {
      questions: [
        { prompt: 'What do the authors recommend combining?', options: ['Human review with public leaderboards','Automated scoring with periodic expert audits','Synthetic data with larger models','Fast releases with user surveys'], correct_index: 1 },
        { prompt: 'Which common pitfalls do the authors list?', options: ['Slow hardware and high energy use','Missing documentation and unclear licenses','Small models and short prompts','Leaked test data and overly narrow benchmarks'], correct_index: 3 },
        { prompt: 'What does the framework cover after a system is updated?', options: ['Tracking regressions','Retraining from scratch','Rewriting every metric','Retiring the test sets'], correct_index: 0 },
      ],
    },
  },
  {
    id: 'mock-3',
    source_company: 'Meta',
    source_url: 'https://ai.meta.com/research/',
    content_type: 'Tech Blog',
    title: 'Scaling Recommendation Inference on Commodity Hardware',
    summary:
      'Engineers describe how a team reduced latency and cost when serving recommendation models at scale. The post covers request batching, caching of frequently used embeddings and a staged rollout that compared old and new serving paths. It closes with lessons on monitoring tail latency and keeping model quality steady during infrastructure changes.',
    published_at: '2026-09-30T11:15:00Z',
    fetched_at: FETCHED_AT,
    reader_count: 211,
    topic: 'Cloud',
    quiz: {
      questions: [
        { prompt: 'What did the team reduce when serving recommendation models?', options: ['Model size and training time','Latency and cost','Data labeling effort','Storage for old logs'], correct_index: 1 },
        { prompt: 'What does the post say was cached?', options: ['Raw user messages','Full web pages','Frequently used embeddings','Training checkpoints'], correct_index: 2 },
        { prompt: 'How was the new serving path rolled out?', options: ['In stages, compared with the old path','All at once overnight','Region by region without comparing','To employees first, with no comparison'], correct_index: 0 },
      ],
    },
  },
  {
    id: 'mock-4',
    source_company: 'OpenAI',
    source_url: 'https://openai.com/news/',
    content_type: 'Release',
    title: 'Model Update: Improved Tool Calling and Structured Outputs',
    summary:
      'This release note summarizes an update to a language model family aimed at developers. Changes include more reliable function calling, stricter adherence to JSON schemas and lower response latency for short prompts. The notes list affected endpoints, a migration checklist for existing integrations and a deprecation timeline for the previous version, with guidance on testing prompts.',
    published_at: '2026-10-01T16:00:00Z',
    fetched_at: FETCHED_AT,
    reader_count: 342,
  },
  {
    id: 'mock-5',
    source_company: 'McKinsey',
    source_url: 'https://www.mckinsey.com/',
    content_type: 'Consulting',
    title: 'How Large Firms Are Rethinking the Operating Model for AI',
    summary:
      'The article looks at how large organizations are reorganizing teams and decision rights around AI tools. It describes pilots that moved from isolated experiments to shared platforms, the roles that changed most, and the measures leaders used to judge progress. It also notes common obstacles such as unclear ownership, uneven data quality and slow change management.',
    published_at: '2026-09-24T10:00:00Z',
    fetched_at: FETCHED_AT,
    reader_count: 87,
  },
  {
    id: 'mock-6',
    source_company: 'AWS',
    source_url: 'https://aws.amazon.com/blogs/machine-learning/',
    content_type: 'Tech Blog',
    title: 'Building a Retrieval Pipeline with Managed Vector Search',
    summary:
      'A walkthrough shows how to assemble a retrieval-augmented generation pipeline using managed storage, embedding and vector search services. The post explains chunking documents, choosing an embedding model, indexing and filtering results by metadata. It includes a sample architecture, notes on cost drivers and tips for evaluating answer quality on a small labeled question set.',
    published_at: '2026-10-02T08:45:00Z',
    fetched_at: FETCHED_AT,
    reader_count: 87,
  },
  {
    id: 'mock-7',
    source_company: 'BlackRock',
    source_url: 'https://www.blackrock.com/',
    content_type: 'Finance',
    title: 'What Rising Rates Mean for Long-Term Portfolio Construction',
    summary:
      'The piece reviews how a prolonged period of higher interest rates changes assumptions behind long-term portfolios. It compares bond and equity return expectations, discusses duration risk and diversification, and outlines how investors have adjusted their allocations. The author stresses that the conclusions depend on time horizon and that forecasts remain uncertain.',
    published_at: '2026-09-23T08:30:00Z',
    fetched_at: FETCHED_AT,
    reader_count: 73,
  },
  {
    id: 'mock-8',
    source_company: 'Google',
    source_url: 'https://blog.google/technology/ai/',
    content_type: 'Release',
    title: 'Open Model Weights Released for On-Device Use',
    summary:
      'This announcement covers a family of compact language models published with open weights for on-device use. The release lists model sizes, supported languages, license terms and quantized variants intended for phones and laptops. It links to documentation, reference code and evaluation results, and notes known limitations such as reduced accuracy on very long inputs.',
    published_at: '2026-10-02T17:30:00Z',
    fetched_at: FETCHED_AT,
    reader_count: 255,
  },
  {
    id: 'mock-9',
    source_company: 'Y Combinator',
    source_url: 'https://www.ycombinator.com/',
    content_type: 'Venture Capital',
    title: 'How Early-Stage Founders Decide When to Raise',
    summary:
      'This essay discusses how early-stage founders choose the timing of a first funding round. It weighs traction, runway and market conditions, and explains why some teams raise sooner while others wait. It also covers how to prepare a clear story for investors and the trade-offs between giving up equity and moving faster.',
    published_at: '2026-09-22T12:00:00Z',
    fetched_at: FETCHED_AT,
    reader_count: 102,
  },
];
