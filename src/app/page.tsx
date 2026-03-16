'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import Intro from '@/components/Intro'
import { submitVote, subscribeToTally, getSavedVote } from '@/lib/vote'

const MapView = dynamic(() => import('@/components/MapView'), { ssr: false })

type Phase = 'intro' | 'map' | 'results'

export default function Home() {
  const [phase, setPhase] = useState<Phase>('intro')

  useEffect(() => {
    if (getSavedVote() !== null) setPhase('results')
  }, [])

  useEffect(() => {
    if (phase !== 'results') return
    const unsubscribe = subscribeToTally((counts, total) => {
      console.log('=== Downtown vote histogram ===')
      console.log(`Total votes: ${total}`)
      const sorted = Object.entries(counts).sort(
        ([a], [b]) => Number(a) - Number(b),
      )
      for (const [index, count] of sorted) {
        console.log(`  Boundary ${index}: ${count} votes (${((count / total) * 100).toFixed(1)}%)`)
      }
    })
    return unsubscribe
  }, [phase])

  async function handleVote(boundaryIndex: number) {
    setPhase('results')
    await submitVote(boundaryIndex)
  }

  if (phase === 'intro') return <Intro onStart={() => setPhase('map')} />
  return <MapView onVote={handleVote} voted={phase === 'results'} />
}
