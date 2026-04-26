/**
 * Crawl Queue / Scheduler
 *
 * Responsible for:
 * - Pushing new URLs to crawl
 * - Assigning crawl depth
 * - Prioritizing pages
 * - Controlling retries and delays
 *
 * Multi-queue system:
 * - directory_queue: Directory listing pages (highest priority)
 * - company_homepage_queue: Company homepage URLs
 * - company_subpage_queue: About, Contact, Team pages (lower priority)
 */

import { canonicalizeUrl, extractDomain, isValidUrl } from './urlCanonicalizer';

export type QueueName = 'directory' | 'company_homepage' | 'company_subpage';

export type QueuePriority = 'high' | 'normal' | 'low';

export interface CrawlTask {
  id: string;
  url: string;
  canonicalUrl: string;
  domain: string;
  queue: QueueName;
  priority: QueuePriority;
  depth: number;
  maxDepth: number;
  retries: number;
  maxRetries: number;
  addedAt: string;
  scheduledFor?: string; // Delayed execution
  status?: string; // For retry tracking
  metadata?: Record<string, unknown>;
}

export interface QueueConfig {
  maxRetries?: number;
  delayBetweenTasks?: number; // ms
  maxConcurrent?: number;
  maxDepth?: number;
}

const DEFAULT_CONFIG: QueueConfig = {
  maxRetries: 2,
  delayBetweenTasks: 500,
  maxConcurrent: 3,
  maxDepth: 3
};

import { QueueManager, QueueType, JobStatus, CrawlJob } from './queueManager';
import { v4 as uuidv4 } from 'uuid';

interface QueueItem {
  id: string;
  url: string;
  type: 'directory' | 'company_homepage' | 'company_subpage';
  priority: number;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  callback?: (result: any) => void;
}

export class CrawlQueue {
  private queueManager: QueueManager;
  private workerId: string;
  
  constructor() {
    this.queueManager = new QueueManager();
    this.workerId = `worker-${uuidv4()}`;
  }

  /**
   * Add a URL to the crawl queue
   */
  async enqueue(
    url: string,
    type: 'directory' | 'company_homepage' | 'company_subpage',
    priority: number = 1,
    maxAttempts: number = 5,
    callback?: (result: any) => void
  ): Promise<string> {
    // Map the old queue types to the new queue types
    let queueType: QueueType;
    switch (type) {
      case 'directory':
        queueType = QueueType.CRAWL_DIRECTORY;
        break;
      case 'company_homepage':
        queueType = QueueType.CRAWL_COMPANY;
        break;
      case 'company_subpage':
        queueType = QueueType.CRAWL_COMPANY;
        break;
      default:
        queueType = QueueType.CRAWL_DIRECTORY;
    }

    // Add job to the database-backed queue
    return await this.queueManager.enqueue(
      queueType,
      url,
      priority,
      { type, callback },
      `${url}-${Date.now()}`, // idempotency key
      maxAttempts
    );
  }

  /**
   * Process the next available job in the queue
   */
  async processNext(): Promise<CrawlJob | null> {
    const queueTypes = [
      QueueType.CRAWL_DIRECTORY,
      QueueType.CRAWL_COMPANY,
      QueueType.DIRECTORY_PARSE,
      QueueType.WEBSITE_RESOLVE,
      QueueType.COMPANY_HOMEPAGE_FETCH,
      QueueType.COMPANY_PRIORITY_PAGE_FETCH
    ];

    return await this.queueManager.claimJob(queueTypes, this.workerId);
  }

  /**
   * Mark a job as completed
   */
  async completeJob(jobId: string): Promise<boolean> {
    return await this.queueManager.completeJob(jobId);
  }

  /**
   * Mark a job as failed
   */
  async failJob(jobId: string, errorMessage?: string): Promise<boolean> {
    return await this.queueManager.failJob(jobId, errorMessage);
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<Record<string, number>> {
    const dirStats = await this.queueManager.getQueueStats(QueueType.CRAWL_DIRECTORY);
    const companyStats = await this.queueManager.getQueueStats(QueueType.CRAWL_COMPANY);

    return {
      directory_pending: dirStats.pending,
      directory_processing: dirStats.processing,
      directory_completed: dirStats.completed,
      directory_failed: dirStats.failed,
      company_pending: companyStats.pending,
      company_processing: companyStats.processing,
      company_completed: companyStats.completed,
      company_failed: companyStats.failed,
      total_pending: dirStats.pending + companyStats.pending,
      total_processing: dirStats.processing + companyStats.processing,
    };
  }

  /**
   * Retry failed jobs in the queue
   */
  async retryFailedJobs(): Promise<number> {
    const dirRetryCount = await this.queueManager.retryFailedJobs(QueueType.CRAWL_DIRECTORY);
    const companyRetryCount = await this.queueManager.retryFailedJobs(QueueType.CRAWL_COMPANY);
    return dirRetryCount + companyRetryCount;
  }

  /**
   * Get jobs by status for monitoring/debugging
   */
  async getJobsByStatus(status: JobStatus, limit: number = 20): Promise<CrawlJob[]> {
    const dirJobs = await this.queueManager.getJobsByStatus(QueueType.CRAWL_DIRECTORY, status, limit / 2);
    const companyJobs = await this.queueManager.getJobsByStatus(QueueType.CRAWL_COMPANY, status, limit / 2);
    return [...dirJobs, ...companyJobs];
  }
}

// Export singleton instance
export const crawlQueue = new CrawlQueue();

/**
 * Process tasks from a crawl queue.
 * Returns a generator that yields tasks one at a time with optional delays.
 */
export async function* processQueue(
  queue: CrawlQueue,
  options: { delayMs?: number; maxTasks?: number } = {}
): AsyncGenerator<CrawlTask> {
  let processed = 0;
  const maxTasks = options.maxTasks || Infinity;
  const delay = options.delayMs || 0;

  while (!queue.isEmpty() && processed < maxTasks) {
    const task = queue.dequeue();
    if (!task) break;

    // Check if task is scheduled for later
    if (task.scheduledFor && new Date(task.scheduledFor) > new Date()) {
      // Re-enqueue for later
      queue.enqueue(task.url, task.queue, {
        depth: task.depth,
        maxDepth: task.maxDepth,
        priority: task.priority,
        metadata: task.metadata
      });
      // Skip for now
      continue;
    }

    processed++;
    yield task;

    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
