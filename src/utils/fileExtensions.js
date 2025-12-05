export const fileValidation = {
    // 1. (Images)
    image: [
        'image/jpeg', 
        'image/png', 
        'image/gif', 
        'image/webp', 
        'image/svg+xml', 
        'image/bmp'
    ],

    // 2. (Documents & Presentations)
    file: [
        'application/pdf',
        // Word
        'application/msword', 
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        // PowerPoint 
        'application/vnd.ms-powerpoint', 
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        // Excel 
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/csv',
        // Text Files
        'text/plain'
    ],

    // 3. (Video)
    video: [
        'video/mp4', 
        'video/mkv', 
        'video/x-matroska', 
        'video/avi', 
        'video/webm',
        'video/quicktime' 
    ],

    // 4. (Audio)
    audio: [
        'audio/mpeg', 
        'audio/wav', 
        'audio/ogg'
    ],

    // 5. (Coding & Archives)
    code: [
        // Archives 
        'application/zip',
        'application/x-zip-compressed',
        'application/x-rar-compressed',
        'application/x-7z-compressed',
        
        // Web Code
        'application/json',
        'text/javascript',
        'text/css',
        'text/html',
        
        // Programming Languages 
        'text/x-python',
        'text/x-java-source',
        'text/x-c',
        'text/x-c++'
    ],

    // 6. (Matlab & Engineering)
    engineering: [
        // Matlab
        'text/x-matlab', 
        'application/x-matlab-data',
        // AutoCAD 
        'image/vnd.dwg',
        'application/acad',
        'application/x-acad'
    ]
};