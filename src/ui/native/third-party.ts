/**
 * Open-source notices for what v2 adds to the app (shown in v1's Settings › About › Open Source Licenses,
 * appended by v1-hooks.ts; the same list is in THIRD_PARTY_NOTICES.md at the repo root).
 */
import APACHE_2_0 from '../../../licenses/Apache-2.0.txt';

export interface Notice {
  name: string;
  license: string;
  text: string;
}

const apache = (who: string, what: string): string => `${what}\n${who}\n\nLicensed under the Apache License, Version 2.0.\n\n${APACHE_2_0}`;

export const V2_NOTICES: Notice[] = [
  {
    name: 'Kokoro-82M (voice model)',
    license: 'Apache-2.0',
    text: apache(
      'Copyright hexgrad (https://huggingface.co/hexgrad/Kokoro-82M)',
      'Kokoro-82M v1.0 text-to-speech model and voices (af_heart, af_bella, bf_emma, am_michael, am_fenrir, bm_george), bundled in the app.',
    ),
  },
  {
    name: 'Kokoro Core ML conversion',
    license: 'Apache-2.0',
    text: apache(
      'Copyright FluidInference; derived from laishere/kokoro-coreml (Copyright laishere), used with the author’s permission',
      '7-stage Core ML build of Kokoro-82M (https://huggingface.co/FluidInference/kokoro-82m-coreml), English G2P model.',
    ),
  },
  {
    name: 'FluidAudio',
    license: 'Apache-2.0',
    text: apache('Copyright FluidInference and contributors (https://github.com/FluidInference/FluidAudio)', 'On-device speech framework that runs the Kokoro model.'),
  },
  {
    name: 'misaki (pronunciation lexicon)',
    license: 'Apache-2.0',
    text: apache('Copyright hexgrad (https://github.com/hexgrad/misaki)', 'English G2P lexicon data (us_lexicon_cache.json) used by Kokoro.'),
  },
  {
    name: 'NeMo text processing',
    license: 'Apache-2.0',
    text: apache(
      'Copyright (c) NVIDIA CORPORATION & AFFILIATES; Rust port text-processing-rs Copyright FluidInference; rustfst Copyright Alexandre Caulier and contributors (MIT OR Apache-2.0)',
      'Text normalization (numbers, dates, currency) before speech, linked into FluidAudio.',
    ),
  },
  {
    name: 'fastcluster',
    license: 'BSD-2-Clause',
    text: `fastcluster (linked into FluidAudio)\n© 2011 Daniel Müllner; changes from 1.1.24 on © Google Inc.\nAll rights reserved.\n\nRedistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:\n\n* Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.\n* Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.\n\nTHIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
  },
];
