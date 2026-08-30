import { readonly, ref } from 'vue'

const active = ref(false)

export const aiSaveRecoveryActive = readonly(active)

export async function runAiSaveRecovery<T>(operation: () => Promise<T>): Promise<T | undefined> {
  if (active.value) return undefined
  active.value = true
  try {
    return await operation()
  } finally {
    active.value = false
  }
}
