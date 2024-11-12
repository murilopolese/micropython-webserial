import { sleep, HELPER_CODE, extract } from './util.js'

export async function micropythonWebserial(state, emitter) {

  async function readForeverAndReport(cb) {
    try {
      while (true) {
        const { value, done } = await state.reader.read()
        if (done) {
          // Allow the serial port to be closed later.
          state.reader.releaseLock()
          break
        }
        if (value) {
          cb(value)
        }
      }
    } catch (error) {
      // TODO: Handle non-fatal read error.
    }
  }
  async function connect() {
    return new Promise((resolve, reject) => {
      navigator.serial.requestPort()
        .then(async (port) => {
          await port.open({ baudRate: 115200 })
          state.port = port
          state.reader = port.readable.getReader()
          state.writer = port.writable.getWriter()
          resolve(port)
        })
        .catch(reject)
    })
  }
  async function disconnect() {
    try {
      state.writer.releaseLock()
      state.reader.releaseLock()
      await state.port.close()
    } catch(e) {
      console.log(`Can't disconnect`, e)
    }
    return Promise.resolve()
  }
  async function write(str) {
    const textEncoder = new TextEncoder()
    const uint8Array = textEncoder.encode(str)
    await state.writer.write(uint8Array)
  }
  async function readUntil(token) {
    if (state.readingUntil) {
      // Already reading until
      return Promise.reject(new Error('Already running "read until"'))
    }
    // Those variables are going to be referenced on emitter.on('data')
    state.readingUntil = token
    state.readingBuffer = ''
    return new Promise((resolve, reject) => {
      // Those functions are going to be called on emitter.on('data')
      state.resolveReadingUntilPromise = (result) => {
        state.readingUntil = null
        state.readingBuffer = null
        state.resolveReadingUntilPromise = () => false
        state.rejectReadingUntilPromise = () => false
        resolve(result)
      }
      state.rejectReadingUntilPromise = (msg) => {
        state.readingUntil = null
        state.readingBuffer = null
        state.resolveReadingUntilPromise = () => false
        state.rejectReadingUntilPromise = () => false
        reject(new Error(msg))
      }
    })
  }

  async function getPrompt() {
    // also known as stop
    state.rejectReadingUntilPromise('Interrupt execution to get prompt')
    write('\x03\x02')
    await readUntil('>>>')
  }
  async function reset() {
    // also known as stop AND reset
    state.rejectReadingUntilPromise('Interrupt execution to get prompt')
    write('\x04')
    await readUntil('>>>')
  }
  async function enterRawRepl() {
    write('\x01')
    await readUntil('raw REPL; CTRL-B to exit')
  }
  async function exitRawRepl() {
    write('\x02')
    await readUntil('>>>')
  }
  async function executeRaw(code) {
    const S = 128
    for (let i = 0; i < code.length; i += S) {
      const c = code.slice(i, i+S)
      await write(c)
      await sleep(10)
    }
    await write('\x04')
    return await readUntil('\x04>')
  }

  async function runHelper() {
    await getPrompt()
    await enterRawRepl()
    const out = await executeRaw(HELPER_CODE)
    await exitRawRepl()
    return out
  }

  async function run(code) {
    await getPrompt()
    try {
      await enterRawRepl()
      for (let i = 0; i < code.length; i += 128) {
        const c = code.slice(i, i+128)
        await write(c)
        await sleep(10)
      }
      await write('\x04')
      await readUntil('\x04>')
      await exitRawRepl()
    } catch(e) {
      console.log('error', e)
    }
  }
  async function getBoardFiles(path) {
    await runHelper()
    await enterRawRepl()
    const out = await executeRaw(`print(json.dumps(get_all_files("")))`)
    await exitRawRepl()

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
  async function loadFile(path) {
    await getPrompt()
    await enterRawRepl()
    let output = await executeRaw(
      `with open('${path}','r') as f:\n while 1:\n  b=f.read(256)\n  if not b:break\n  print(b,end='')`
    )
    await exitRawRepl()
    return extract(output)
  }
  async function saveFile(path, content) {
    // Content is a string
    await getPrompt()
    await enterRawRepl()
    await executeRaw(`f=open('${path}','wb')\nw=f.write`)
    const d = new TextEncoder().encode(content)
    await executeRaw(`w(bytes([${d}]))`)
    await executeRaw(`f.close()`)
    await exitRawRepl()
  }
  async function removeFile(path) {
    await getPrompt()
    await enterRawRepl()
    let command = `import uos\n`
        command += `try:\n`
        command += `  uos.remove("${path}")\n`
        command += `except OSError:\n`
        command += `  print(0)\n`
    await executeRaw(command)
    await exitRawRepl()
  }
  async function removeFolder(path) {
    await getPrompt()
    await runHelper()
    await enterRawRepl()
    await executeRaw(`delete_folder('${path}')`)
    await exitRawRepl()
  }
  async function createBoardFile(path) {
    await getPrompt()
    await enterRawRepl()
    let command = `f=open('${path}', 'w');f.close()`
    await executeRaw(command)
    await exitRawRepl()
  }
  async function createBoardFolder(path) {
    await getPrompt()
    await enterRawRepl()
    let command = `import os;os.mkdir('${path}')`
    await executeRaw(command)
    await exitRawRepl()
  }
  async function renameItem(srcPath, destPath) {
    await getPrompt()
    await enterRawRepl()
    let command = `import os;os.rename('${srcPath}','${destPath}')`
    await executeRaw(command)
    await exitRawRepl()
  }

  async function uploadFile(path, content) {
    // Content is a typed array
    await getPrompt()
    await enterRawRepl()
    await executeRaw(`f=open('${path}','wb')\nw=f.write`)
    for (let i = 0; i < content.byteLength; i += 128) {
      const c = new Uint8Array(content.slice(i, i+128))
      await executeRaw(`w(bytes([${c}]))`)
    }
    await executeRaw(`f.close()`)
    await exitRawRepl()
    return Promise.resolve()
  }

  async function downloadFile(path) {
    await getPrompt()
    await runHelper()
    await enterRawRepl()
    const output = await executeRaw(
`with open('${path}','rb') as f:
  b = b2a_base64(f.read())
  for i in b:
    print( chr(i), end='' )
`
    )
    await exitRawRepl()
    return extract(output)
  }

  return {
    readForeverAndReport,
    connect,
    disconnect,
    write,
    readUntil,
    getPrompt,
    reset,
    enterRawRepl,
    exitRawRepl,
    executeRaw,
    runHelper,
    run,
    getBoardFiles,
    loadFile,
    removeFolder,
    saveFile,
    removeFile,
    createBoardFile,
    createBoardFolder,
    renameItem,
    uploadFile,
    downloadFile
  }

}
