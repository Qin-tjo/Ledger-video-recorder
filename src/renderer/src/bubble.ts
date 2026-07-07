const params = new URLSearchParams(window.location.search)
const deviceId = params.get('device') || undefined

const video = document.getElementById('cam') as HTMLVideoElement

navigator.mediaDevices
  .getUserMedia({
    video: deviceId ? { deviceId: { exact: deviceId } } : true,
    audio: false
  })
  .then((stream) => {
    video.srcObject = stream
  })
  .catch((err) => {
    console.error('bubble camera error', err)
  })
