const mongoose = require('mongoose');

/**
 * Execute operations within a MongoDB transaction
 * Ensures atomicity for multi-document updates
 * 
 * Usage:
 * await withTransaction(async (session) => {
 *   user.balance -= amount;
 *   await user.save({ session });
 *   recipient.balance += amount;
 *   await recipient.save({ session });
 * });
 */
async function withTransaction(callback) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const result = await callback(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
}

/**
 * Execute operations with retry logic for transient failures
 */
async function withRetry(callback, maxRetries = 3, delayMs = 100) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;
      
      // Don't retry on specific errors
      if (error.code === 11000 || error.name === 'ValidationError') {
        throw error;
      }
      
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  
  throw lastError;
}

/**
 * Combined: transaction with retry logic
 */
async function withTransactionAndRetry(callback, maxRetries = 3) {
  return withRetry(() => withTransaction(callback), maxRetries);
}

module.exports = {
  withTransaction,
  withRetry,
  withTransactionAndRetry
};
