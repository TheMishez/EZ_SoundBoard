cmake_minimum_required(VERSION 3.20)
project(MishezPadNative LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "The Mishez Pad mic plugin is Windows-only. Build with Visual Studio 2022 (x64).")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Static CRT: the plugin runs inside audiodg.exe and must not depend on a VC++ redistributable.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
add_compile_definitions(UNICODE _UNICODE NOMINMAX)
add_compile_options(/W3 /EHsc /permissive-)

set(OUT_DIR ${CMAKE_CURRENT_SOURCE_DIR}/bin)
foreach(cfg "" _DEBUG _RELEASE _RELWITHDEBINFO _MINSIZEREL)
  set(CMAKE_RUNTIME_OUTPUT_DIRECTORY${cfg} ${OUT_DIR})
  set(CMAKE_LIBRARY_OUTPUT_DIRECTORY${cfg} ${OUT_DIR})
endforeach()

# The plugin Windows loads into the microphone pipeline
add_library(MishezPadApo SHARED apo/MishezApo.cpp apo/MishezApo.def)
target_link_libraries(MishezPadApo PRIVATE ole32 advapi32 shell32 uuid)

# Streams the app's sound mix into the plugin (runs as the normal user)
add_executable(mishez-bridge bridge/bridge.cpp)
target_link_libraries(mishez-bridge PRIVATE ole32 advapi32 shell32)

# Enables / disables the plugin on microphones (runs elevated)
add_executable(mishez-apo-setup setup/setup.cpp)
target_link_libraries(mishez-apo-setup PRIVATE ole32 advapi32 shell32 uuid)
