import { grabGray, sampleFrameBoxes } from './ffmpeg'
import {
  buildGeometry,
  fallbackRegion,
  fitRegion,
  nearestPairs,
  pictureShape,
  referencePicture,
  sizeClasses,
  type Fit,
  type SourceGeometry
} from './sourceGeometry'

/** Frame sizes measured per recording (others use the shape rule). */
const MAX_SIZES = 12
/** Frame pairs tried per size; the best-matching one is used. */
const PAIRS_PER_SIZE = 4

/**
 * Work out a recording's steady picture (see sourceGeometry.ts): sample frame
 * sizes from a few stretches, then for each size other than the most common,
 * measure which region of it matches the common size's picture, using pairs
 * of frames taken moments apart.
 */
export async function analyzeSource(src: string): Promise<SourceGeometry | null> {
  const samples = await sampleFrameBoxes(src, [0, 60, 240, 600], 15)
  const classes = sizeClasses(samples)
  if (classes.length <= 1) return buildGeometry(classes, new Map())

  const ref = classes[0]
  const shape = pictureShape(classes)
  const fits = new Map<string, (Fit | null)[]>()
  await Promise.all(
    classes.slice(1, MAX_SIZES).map(async (k) => {
      const results = await Promise.all(
        nearestPairs(k, ref, PAIRS_PER_SIZE).map(async ([tk, tr]) => {
          const [frame, refFrame] = await Promise.all([
            grabGray(src, tk, k.w, k.h),
            grabGray(src, tr, ref.w, ref.h)
          ])
          if (!frame || !refFrame) return null
          return fitRegion(frame, k, referencePicture(refFrame, shape.refBox), fallbackRegion(k.w, k.h, shape))
        })
      )
      fits.set(`${k.w}x${k.h}`, results)
    })
  )
  return buildGeometry(classes, fits)
}
