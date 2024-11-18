import { EventEmitter } from './event-emitter.js'
import { HELPER_CODE, sleep, extract } from './util.js'

export class MicroPython extends EventEmitter {
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
    this.writer = null
    this.readingBuffer = null
    this.readingUntil = null
    this.resolveReadingUntilPromise = () => false
    this.rejectReadingUntilPromise = () => false
  }

  async #readForeverAndReport() {
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

  #onData(buffer) {
    if (this.readingUntil != null) {
      this.readingBuffer += (new TextDecoder()).decode(buffer)
      if (this.readingBuffer.indexOf(this.readingUntil) != -1) {
        const response = this.readingBuffer
        this.readingUntil = null
        this.readingBuffer = null
        this.resolveReadingUntilPromise(response)
      }
    }
  }

  async connect() {
    const port = await navigator.serial.requestPort()
    if (port) {
      await port.open({ baudRate: this.baudRate })
      this.port = port
      this.isConnected = true
      this.reader = port.readable.getReader()
      this.writer = port.writable.getWriter()

      this.#readForeverAndReport()
      this.on('data', this.#onData)

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
    this.removeListener('data', this.#onData)
  }
  async write(str) {
    const textEncoder = new TextEncoder()
    const uint8Array = textEncoder.encode(str)
    await this.writer.write(uint8Array)
  }
  async readUntil(token) {
    if (this.readingUntil != null) {
      return Promise.reject(new Error(`Already running "read until"`))
    }
    this.readingBuffer = ''
    this.readingUntil = token
    return new Promise((resolve, reject) => {
      // Those functions are going to be called on emitter.on('data')
      this.resolveReadingUntilPromise = (result) => {
        this.readingUntil = null
        this.readingBuffer = null
        this.resolveReadingUntilPromise = () => false
        this.rejectReadingUntilPromise = () => false
        resolve(result)
      }
      this.rejectReadingUntilPromise = (msg) => {
        this.readingUntil = null
        this.readingBuffer = null
        this.resolveReadingUntilPromise = () => false
        this.rejectReadingUntilPromise = () => false
        reject(new Error(msg))
      }
    })

  }
  async getPrompt() {
    // also known as stop
    if (this.readingUntil) {
      this.rejectReadingUntilPromise('Interrupt execution to get prompt')
    }
    this.write('\x03\x02')
    await this.readUntil('>>>')
  }
  async enterRawRepl() {
    this.write('\x01')
    await this.readUntil('raw REPL; CTRL-B to exit')
  }
  async exitRawRepl() {
    this.write('\x02')
    await this.readUntil('>>>')
  }
  async executeRaw(code) {
    const S = 128
    for (let i = 0; i < code.length; i += S) {
      const c = code.slice(i, i+S)
      await this.write(c)
      await sleep(10)
    }
    await this.write('\x04')
    return await this.readUntil('\x04>')
  }
  async softReset() {
    // also known as stop AND reset
    await this.getPrompt()
    this.write('\x04')
    await this.readUntil('>>>')
  }
  async stop() {
    await this.getPrompt()
  }
  async run(code) {
    await this.getPrompt()
    await this.enterRawRepl()
    await this.executeRaw(code)
    await this.write('\x04')
    await this.readUntil('\x04>')
    await this.exitRawRepl()
  }
  async runHelper() {
    await this.getPrompt()
    await this.enterRawRepl()
    const out = await this.executeRaw(HELPER_CODE)
    await this.exitRawRepl()
    return out
  }

  async listFiles(path) {
    await this.runHelper()
    await this.enterRawRepl()
    const out = await this.executeRaw(`print(json.dumps(get_all_files("")))`)
    await this.exitRawRepl()

    const result = extract(out)
    const files = JSON.parse(result)

    // Hold you hat, nested reduce ahead
    // TODO: Optimize this step
    let tree = files.reduce((r, file) => {
      file.path.split('/')
      .filter(a => a)
      .reduce((childNodes, title) => {
        let child = childNodes.find(n => n.title === title)
        if (!child) {
          child = {
            title: title,
            type: file.type,
            path: file.path,
            childNodes: []
          }
          childNodes.push(child)
        }
        // Sort by type, alphabetically
        childNodes = childNodes.sort((a, b) => {
          return b.type.localeCompare(a.type) || a.title.localeCompare(b.title)
        })
        return child.childNodes
      }, r)
      return r
    }, [])
    // Sort by type, alphabetically
    tree = tree.sort((a, b) => {
      return b.type.localeCompare(a.type) || a.title.localeCompare(b.title)
    })
    return tree
  }

  createFolder(path) {}
  removeFolder(path) {}
  renameFolder(oldPath, newPath) {}

  createFile(path, content) {}
  saveFile(path, content) {}
  removeFile(path) {}
  renameFile(oldPath, newPath) {}

  downloadFile(source, destination) {}
  uploadFile(source, destination) {}

}
