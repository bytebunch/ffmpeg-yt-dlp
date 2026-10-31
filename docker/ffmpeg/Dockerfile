# media-ffmpeg: FFmpeg built from source with whisper.cpp, the base of the media-service image
# (SPEC §17, DEPLOY.md §5). BtbN's static releases ship whisper disabled, hence this build.
# Codec libraries come from Debian packages; the runtime stage installs exactly the packages
# that provide the libraries ffmpeg/ffprobe link against. whisper.cpp and libvmaf (which Debian
# 13 does not package) are built from source and linked statically.

ARG DEBIAN_RELEASE=trixie

FROM debian:${DEBIAN_RELEASE}-slim AS build
ARG FFMPEG_VERSION=n8.1.3
ARG WHISPER_VERSION=v1.9.5
ARG VMAF_VERSION=v3.0.0
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential cmake meson ninja-build pkg-config nasm xxd git ca-certificates \
      libx264-dev libx265-dev libvpx-dev libaom-dev libsvtav1enc-dev libdav1d-dev \
      libopus-dev libmp3lame-dev libvorbis-dev \
      libass-dev libfreetype-dev libharfbuzz-dev libfontconfig-dev libfribidi-dev \
      libvidstab-dev libzimg-dev libwebp-dev libsoxr-dev librubberband-dev zlib1g-dev \
      libgnutls28-dev \
 && rm -rf /var/lib/apt/lists/*

# whisper.cpp: static, CPU only, no OpenMP. GGML_NATIVE=OFF: a native build would target the
# build machine's CPU and could crash elsewhere with "illegal instruction"; amd64 gets the
# AVX2 baseline the servers are checked for (DEPLOY.md §2b).
RUN git clone --depth 1 --branch "${WHISPER_VERSION}" https://github.com/ggml-org/whisper.cpp /src/whisper \
 && case "${TARGETARCH}" in \
      amd64) cpu_flags="-DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_BMI2=ON" ;; \
      *) cpu_flags="" ;; \
    esac \
 && cmake -S /src/whisper -B /src/whisper/build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/whisper -DCMAKE_INSTALL_LIBDIR=lib \
      -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=OFF \
      -DWHISPER_BUILD_SERVER=OFF -DGGML_OPENMP=OFF -DGGML_NATIVE=OFF ${cpu_flags} \
 && cmake --build /src/whisper/build \
 && cmake --install /src/whisper/build \
 && sed -i 's|^Libs:.*|Libs: -L${libdir} -lwhisper -lggml -lggml-cpu -lggml-base -lstdc++ -lm -lpthread|' \
      /opt/whisper/lib/pkgconfig/whisper.pc

RUN git clone --depth 1 --branch "${VMAF_VERSION}" https://github.com/Netflix/vmaf /src/vmaf \
 && meson setup /src/vmaf/libvmaf/build /src/vmaf/libvmaf \
      --buildtype=release --prefix=/opt/vmaf --libdir=lib --default-library=static \
      -Denable_tests=false -Denable_docs=false -Dbuilt_in_models=true \
 && ninja -C /src/vmaf/libvmaf/build install

# libvmaf contains C++ (libsvm); a static link needs its private libraries, and ffmpeg's
# configure reads only Libs (it does not pass --static to pkg-config).
RUN sed -i 's|^Libs:.*|Libs: -L${libdir} -lvmaf -lstdc++ -lm -lpthread|' /opt/vmaf/lib/pkgconfig/libvmaf.pc

RUN git clone --depth 1 --branch "${FFMPEG_VERSION}" https://git.ffmpeg.org/ffmpeg.git /src/ffmpeg \
 && cd /src/ffmpeg \
 && PKG_CONFIG_PATH=/opt/whisper/lib/pkgconfig:/opt/vmaf/lib/pkgconfig ./configure \
      --prefix=/opt/ffmpeg --enable-gpl --disable-doc --disable-debug --disable-ffplay \
      --enable-libx264 --enable-libx265 --enable-libvpx --enable-libaom --enable-libsvtav1 --enable-libdav1d \
      --enable-libopus --enable-libmp3lame --enable-libvorbis \
      --enable-libass --enable-libfreetype --enable-libharfbuzz --enable-libfontconfig --enable-libfribidi \
      --enable-libvidstab --enable-libzimg --enable-libvmaf --enable-libwebp --enable-libsoxr --enable-librubberband \
      --enable-whisper \
      --enable-gnutls \
      || { tail -40 ffbuild/config.log; exit 1; } \
 && make -j"$(nproc)" \
 && make install

# GnuTLS (LGPL, so no --enable-nonfree): yt-dlp hands live HLS and some downloads to ffmpeg as
# https URLs (SPEC §7d); without TLS ffmpeg fails with exit code 8.
# The Debian packages that provide every shared library ffmpeg and ffprobe load.
RUN ldd /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe | awk '$3 ~ /^\// { print $3 }' | sort -u \
      | xargs realpath | xargs dpkg -S | cut -d: -f1 | sort -u >/opt/ffmpeg/runtime-packages.txt

FROM debian:${DEBIAN_RELEASE}-slim
# Kept in the image so other images (the dev toolbox) can install the same runtime libraries.
COPY --from=build /opt/ffmpeg/runtime-packages.txt /usr/local/share/media-ffmpeg/runtime-packages.txt
RUN apt-get update \
 && xargs -a /usr/local/share/media-ffmpeg/runtime-packages.txt apt-get install -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/
# whisper.cpp's sample (MIT), used by acceptance and smoke tests.
COPY --from=build /src/whisper/samples/jfk.wav /usr/local/share/media-ffmpeg/jfk.wav
LABEL org.opencontainers.image.title="media-ffmpeg"
