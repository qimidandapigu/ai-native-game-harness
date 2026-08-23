export type FeedbackCategory = 'feature_request'

export interface FeedbackSubmission {
  category: FeedbackCategory
  title: string
  summary: string
  playerQuote: string
  gameId: string
  adapterId: string
}
export interface FeedbackReport extends FeedbackSubmission {
  schemaVersion: 1
  reportId: string
  submittedAt: string
  source: {
    product: 'dsh-xiaotangyuan-game'
    pluginVersion: string
    clientId: string
  }
}

export interface FeedbackReceipt {
  accepted: true
  reportId: string
  issueNumber?: number
  issueUrl?: string
}

export interface FeedbackSubmitter {
  submit(submission: FeedbackSubmission, signal: AbortSignal): Promise<FeedbackReceipt>
}
