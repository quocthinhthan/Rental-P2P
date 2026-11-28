// frontend/src/utils/qrCode.js
// Self-contained ISO/IEC 18004 QR Code encoder (Byte mode, ECC Level M, Versions 1..12).
// Generates QR matrices locally in the browser with zero network calls or external dependencies,
// ensuring verification handoff URLs are never sent to third-party QR services.

const VERSION_PARAMS_M = [
  null,
  { totalCodewords: 26, ecPerBlock: 10, numBlocks: 1, align: [] },
  { totalCodewords: 44, ecPerBlock: 16, numBlocks: 1, align: [6, 18] },
  { totalCodewords: 70, ecPerBlock: 26, numBlocks: 1, align: [6, 22] },
  { totalCodewords: 100, ecPerBlock: 18, numBlocks: 2, align: [6, 26] },
  { totalCodewords: 134, ecPerBlock: 24, numBlocks: 2, align: [6, 30] },
  { totalCodewords: 172, ecPerBlock: 16, numBlocks: 4, align: [6, 34] },
  { totalCodewords: 196, ecPerBlock: 18, numBlocks: 4, align: [6, 22, 38] },
  { totalCodewords: 242, ecPerBlock: 22, numBlocks: 4, align: [6, 24, 42] },
  { totalCodewords: 292, ecPerBlock: 22, numBlocks: 5, align: [6, 26, 46] },
  { totalCodewords: 346, ecPerBlock: 26, numBlocks: 5, align: [6, 28, 50] },
  { totalCodewords: 404, ecPerBlock: 30, numBlocks: 5, align: [6, 30, 54] },
  { totalCodewords: 466, ecPerBlock: 22, numBlocks: 8, align: [6, 32, 58] }
];

const gfMultiply = (x, y) => {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
};

const rsComputeDivisor = (degree) => {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) {
        result[j] ^= result[j + 1];
      }
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
};

const rsComputeRemainder = (data, divisor) => {
  const result = new Uint8Array(divisor.length);
  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i] ^ result[0];
    result.copyWithin(0, 1);
    result[divisor.length - 1] = 0;
    for (let j = 0; j < divisor.length; j += 1) {
      result[j] ^= gfMultiply(divisor[j], factor);
    }
  }
  return result;
};

const appendBits = (val, len, bitArray) => {
  for (let i = len - 1; i >= 0; i -= 1) {
    bitArray.push((val >>> i) & 1);
  }
};

const getBit = (val, index) => ((val >>> index) & 1) !== 0;

const selectVersionForBytes = (byteLength) => {
  for (let ver = 1; ver < VERSION_PARAMS_M.length; ver += 1) {
    const { totalCodewords, ecPerBlock, numBlocks } = VERSION_PARAMS_M[ver];
    const dataCodewords = totalCodewords - ecPerBlock * numBlocks;
    const countIndicatorBits = ver <= 9 ? 8 : 16;
    const availableDataBits = dataCodewords * 8 - 4 - countIndicatorBits;
    if (byteLength * 8 <= availableDataBits) {
      return ver;
    }
  }
  throw new Error('QR payload exceeds supported length');
};

const buildInterleavedCodewords = (utf8Bytes, version) => {
  const { totalCodewords, ecPerBlock, numBlocks } = VERSION_PARAMS_M[version];
  const dataCodewordsCount = totalCodewords - ecPerBlock * numBlocks;
  const dataCapacityBits = dataCodewordsCount * 8;

  const bits = [];
  // Byte mode indicator = 0100
  appendBits(0b0100, 4, bits);
  appendBits(utf8Bytes.length, version <= 9 ? 8 : 16, bits);
  for (let i = 0; i < utf8Bytes.length; i += 1) {
    appendBits(utf8Bytes[i], 8, bits);
  }

  // Terminator (up to 4 zero bits)
  appendBits(0, Math.min(4, dataCapacityBits - bits.length), bits);
  // Pad to byte boundary
  appendBits(0, (8 - (bits.length % 8)) % 8, bits);

  // Pad alternating 0xEC, 0x11 codewords
  let padToggle = 0;
  while (bits.length < dataCapacityBits) {
    appendBits(padToggle === 0 ? 0xec : 0x11, 8, bits);
    padToggle ^= 1;
  }

  const dataCodewords = new Uint8Array(dataCodewordsCount);
  for (let i = 0; i < bits.length; i += 1) {
    dataCodewords[i >>> 3] |= bits[i] << (7 - (i & 7));
  }

  const numShortBlocks = numBlocks - (totalCodewords % numBlocks);
  const shortBlockTotalLen = Math.floor(totalCodewords / numBlocks);
  const shortDataLen = shortBlockTotalLen - ecPerBlock;
  const rsDivisor = rsComputeDivisor(ecPerBlock);

  const blocksData = [];
  const blocksEcc = [];
  let offset = 0;

  for (let b = 0; b < numBlocks; b += 1) {
    const dataLen = shortDataLen + (b < numShortBlocks ? 0 : 1);
    const slice = dataCodewords.subarray(offset, offset + dataLen);
    offset += dataLen;
    blocksData.push(slice);
    blocksEcc.push(rsComputeRemainder(slice, rsDivisor));
  }

  const result = new Uint8Array(totalCodewords);
  let outIdx = 0;
  const maxDataLen = shortDataLen + (numShortBlocks < numBlocks ? 1 : 0);

  for (let i = 0; i < maxDataLen; i += 1) {
    for (let b = 0; b < numBlocks; b += 1) {
      if (i < blocksData[b].length) {
        result[outIdx] = blocksData[b][i];
        outIdx += 1;
      }
    }
  }

  for (let i = 0; i < ecPerBlock; i += 1) {
    for (let b = 0; b < numBlocks; b += 1) {
      result[outIdx] = blocksEcc[b][i];
      outIdx += 1;
    }
  }

  return result;
};

const drawFunctionPatterns = (version) => {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => Array(size).fill(false));

  const setFunctionModule = (row, col, isDark) => {
    if (row < 0 || row >= size || col < 0 || col >= size) return;
    modules[row][col] = Boolean(isDark);
    isFunction[row][col] = true;
  };

  const drawFinderPattern = (centerCol, centerRow) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const r = centerRow + dy;
        const c = centerCol + dx;
        if (r >= 0 && r < size && c >= 0 && c < size) {
          setFunctionModule(r, c, dist !== 2 && dist !== 4);
        }
      }
    }
  };

  const drawAlignmentPattern = (centerCol, centerRow) => {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        setFunctionModule(centerRow + dy, centerCol + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  };

  // Timing patterns
  for (let i = 0; i < size; i += 1) {
    setFunctionModule(6, i, i % 2 === 0);
    setFunctionModule(i, 6, i % 2 === 0);
  }

  // Three finder patterns + separators
  drawFinderPattern(3, 3);
  drawFinderPattern(size - 4, 3);
  drawFinderPattern(3, size - 4);

  // Alignment patterns
  const alignCoords = VERSION_PARAMS_M[version].align;
  for (let i = 0; i < alignCoords.length; i += 1) {
    for (let j = 0; j < alignCoords.length; j += 1) {
      const isCornerFinder = (i === 0 && j === 0)
        || (i === 0 && j === alignCoords.length - 1)
        || (i === alignCoords.length - 1 && j === 0);
      if (!isCornerFinder) {
        drawAlignmentPattern(alignCoords[i], alignCoords[j]);
      }
    }
  }

  // Reserve format info bits + dark module
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      setFunctionModule(i, 8, false);
      setFunctionModule(8, i, false);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    setFunctionModule(8, size - 1 - i, false);
  }
  for (let i = 0; i < 7; i += 1) {
    setFunctionModule(size - 1 - i, 8, false);
  }
  setFunctionModule(size - 8, 8, true);

  // Version info for version >= 7
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    const verBits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const bit = getBit(verBits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunctionModule(a, b, bit);
      setFunctionModule(b, a, bit);
    }
  }

  return { size, modules, isFunction, setFunctionModule };
};

const drawFormatBits = (modules, isFunction, size, mask) => {
  // ECC Level M format indicator = 0b00
  const data = (0b00 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  const bits = ((data << 10) | rem) ^ 0x5412;

  const setFixed = (r, c, val) => {
    modules[r][c] = val;
    isFunction[r][c] = true;
  };

  for (let i = 0; i <= 5; i += 1) setFixed(i, 8, getBit(bits, i));
  setFixed(7, 8, getBit(bits, 6));
  setFixed(8, 8, getBit(bits, 7));
  setFixed(8, 7, getBit(bits, 8));
  for (let i = 9; i < 15; i += 1) setFixed(8, 14 - i, getBit(bits, i));

  for (let i = 0; i < 8; i += 1) setFixed(8, size - 1 - i, getBit(bits, i));
  for (let i = 8; i < 15; i += 1) setFixed(size - 15 + i, 8, getBit(bits, i));
  setFixed(size - 8, 8, true);
};

const shouldInvertModule = (mask, row, col) => {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return false;
  }
};

const computePenaltyScore = (modules) => {
  const size = modules.length;
  let penalty = 0;

  // Rule 1: 5+ consecutive same-color modules in rows & cols
  for (let r = 0; r < size; r += 1) {
    let runColor = modules[r][0];
    let runLen = 1;
    for (let c = 1; c < size; c += 1) {
      if (modules[r][c] === runColor) {
        runLen += 1;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty += 1;
      } else {
        runColor = modules[r][c];
        runLen = 1;
      }
    }
  }

  for (let c = 0; c < size; c += 1) {
    let runColor = modules[0][c];
    let runLen = 1;
    for (let r = 1; r < size; r += 1) {
      if (modules[r][c] === runColor) {
        runLen += 1;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty += 1;
      } else {
        runColor = modules[r][c];
        runLen = 1;
      }
    }
  }

  // Rule 2: 2x2 blocks of identical color
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const color = modules[r][c];
      if (
        color === modules[r][c + 1]
        && color === modules[r + 1][c]
        && color === modules[r + 1][c + 1]
      ) {
        penalty += 3;
      }
    }
  }

  // Rule 4: dark/light balance
  let darkCount = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r][c]) darkCount += 1;
    }
  }
  const total = size * size;
  const k = Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1;
  if (k > 0) penalty += k * 10;

  return penalty;
};

export function encodeQrMatrix(text) {
  if (typeof text !== 'string' || !text) {
    throw new Error('QR text must be a non-empty string');
  }

  const utf8Bytes = new TextEncoder().encode(text);
  const version = selectVersionForBytes(utf8Bytes.length);
  const codewords = buildInterleavedCodewords(utf8Bytes, version);
  const base = drawFunctionPatterns(version);
  const { size, modules: baseModules, isFunction } = base;

  // Zigzag placement of data + ECC bits
  let bitIdx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (!isFunction[row][col] && bitIdx < codewords.length * 8) {
          baseModules[row][col] = getBit(codewords[bitIdx >>> 3], 7 - (bitIdx & 7));
          bitIdx += 1;
        }
      }
    }
  }

  let bestMatrix = null;
  let bestPenalty = Infinity;
  let bestMask = 0;

  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = baseModules.map((row) => row.slice());
    const fnCopy = isFunction.map((row) => row.slice());

    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (!fnCopy[r][c] && shouldInvertModule(mask, r, c)) {
          candidate[r][c] = !candidate[r][c];
        }
      }
    }

    drawFormatBits(candidate, fnCopy, size, mask);
    const penalty = computePenaltyScore(candidate);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMatrix = candidate;
      bestMask = mask;
    }
  }

  return {
    version,
    size,
    mask: bestMask,
    modules: bestMatrix
  };
}

export function buildQrSvgPath(modules, quietZone = 4) {
  const parts = [];
  for (let r = 0; r < modules.length; r += 1) {
    for (let c = 0; c < modules[r].length; c += 1) {
      if (modules[r][c]) {
        parts.push(`M${c + quietZone},${r + quietZone}h1v1h-1z`);
      }
    }
  }
  return parts.join('');
}
