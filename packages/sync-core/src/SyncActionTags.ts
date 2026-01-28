export const RollbackActionTag = "RollbackAction" as const

/**
 * Patch-only action emitted when replay produces effects beyond the received patches
 * (e.g. private-data divergence, conditional logic, or rollback+replay reordering).
 */
export const CorrectionActionTag = "_InternalCorrectionApply" as const
