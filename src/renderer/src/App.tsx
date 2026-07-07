import { AnimatePresence, motion } from 'framer-motion'
import { useApp } from './store'
import Recorder from './recorder/Recorder'
import Editor from './editor/Editor'

export default function App(): JSX.Element {
  const view = useApp((s) => s.view)

  return (
    <div className="h-full w-full flex flex-col bg-ink-900">
      <div className="drag-region h-10 shrink-0" />
      <div className="flex-1 min-h-0 relative">
        <AnimatePresence mode="wait">
          <motion.div
            key={view}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0"
          >
            {view === 'recorder' ? <Recorder /> : <Editor />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}
