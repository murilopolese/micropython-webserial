import { EventEmitter } from './event-emitter.js'

class MicroPython extends EventEmitter {
  constructor() {
    super()
    // Feature detection
    if (!('serial' in navigator)) {
      throw new Error("Browser not supported")
    }

    this.port = null
    this.baudRate = 115200
    this.isConnected = false
    this.reader = null
    this.writter = null
    this.readingBuffer = null
    this.readingUntil = null
    this.resolveReadingUntilPromise = () => false
    this.rejectReadingUntilPromise = () => false
  }

  #readForeverAndReport() {
    try {
      while (true) {
        const { value, done } = await this.reader.read()
        if (done) {
          // Allow the serial port to be closed later.
          this.reader.releaseLock()
          break
        }
        if (value) {
          this.emit('data', value)
        }
      }
    } catch (error) {
      // TODO: Handle non-fatal read error.
    }
  }

  async connect() {
    const port = await navigator.serial.requestPort()
    if (port) {
      await port.open({ baudRate: this.baudRate })
      this.port = port
      this.isConnected = true
      this.reader = port.readable.getReader()
      this.writter = port.writable.getWriter()

      this.#readForeverAndReport()
      this.on('data', (data) => {
        if (this.readingUntil != null) {
          this.readingBuffer += (new TextDecoder()).decode(buff)
          if (this.readingBuffer.indexOf(this.readingUntil) != -1) {
            const response = this.readingBuffer
            this.readingUntil = null
            this.readingBuffer = null
            this.resolveReadingUntilPromise(response)
          }
        }
      })

      return Promise.resolve(port)
    } else {
      return Promise.reject(new Error("No port was selected"))
    }
  }
  async disconnect() {
    this.writer.releaseLock()
    this.reader.releaseLock()
    await this.port.close()
    this.isConnected = false
  }

  async write(str) {
    const textEncoder = new TextEncoder()
    const uint8Array = textEncoder.encode(str)
    await this.writer.write(uint8Array)
  }
  readUntil() {}
  enterRawRepl() {}
  exitRawRepl() {}
  getPrompt() {}
  softReset() {}
  stop() {}
  run() {}

  listFiles() {}

  createFolder() {}
  removeFolder() {}
  renameFolder() {}

  createFile() {}
  saveFile() {}
  removeFile() {}
  renameFile() {}

  downloadFile() {}
  uploadFile() {}

}
