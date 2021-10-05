// PayTec ECR Interface C++ example, using NDJSON format over serial port.
#ifdef _MSC_VER
#define WINDOWS
#endif

#ifdef WINDOWS
#include <winsock2.h>
#pragma comment(lib, "Ws2_32.lib")
#else
#include <termios.h>
#include <unistd.h>
#include <sys/time.h>
#endif

#include <cerrno>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <fcntl.h>
#include <vector>
#include <queue>

using namespace std;


// configurables
#ifdef WINDOWS
#define SERIAL_DEVICE_PATH "\\\\.\\COM1"
#define SERIAL_SERVER_PORT 12345
#else
#define SERIAL_DEVICE_PATH "/dev/ttyUSB0"
#endif

// constants
#define PROTOCOL_VERSION            1
#define SERIAL_TIMEOUT              350
#define MAX_LENGTH_ECR_FRAME        20480
#define MAX_TRIES_SEND_SERIAL_FRAME 3
#define BAUD_RATE 115200

typedef enum ECRMessageType_ {
    ECR_MSG_CONNECT_REQUEST                         = 0x01,
    ECR_MSG_CONNECT_RESPONSE                        = 0x02,
    ECR_MSG_STATUS_REQUEST                          = 0x03,
    ECR_MSG_STATUS_RESPONSE                         = 0x04,
    ECR_MSG_ACTIVATION_REQUEST                      = 0x05,
    ECR_MSG_ACTIVATION_RESPONSE                     = 0x06,
    ECR_MSG_DEACTIVATION_REQUEST                    = 0x07,
    ECR_MSG_DEACTIVATION_RESPONSE                   = 0x08,
    ECR_MSG_TRANSACTION_REQUEST                     = 0x09,
    ECR_MSG_TRANSACTION_RESPONSE                    = 0x10,
    ECR_MSG_TRANSACTION_CONFIRMATION_REQUEST        = 0x11,
    ECR_MSG_TRANSACTION_CONFIRMATION_RESPONSE       = 0x12,
    ECR_MSG_ABORT_TRANSACTION_REQUEST               = 0x13,
    ECR_MSG_ABORT_TRANSACTION_RESPONSE              = 0x14,
    ECR_MSG_BATCH_CAPTURE_REQUEST                   = 0x15,
    ECR_MSG_BATCH_CAPTURE_RESPONSE                  = 0x16,
    ECR_MSG_BALANCE_REQUEST                         = 0x17,
    ECR_MSG_BALANCE_RESPONSE                        = 0x18,
    ECR_MSG_CONFIGURATION_REQUEST                   = 0x19,
    ECR_MSG_CONFIGURATION_RESPONSE                  = 0x20,
    ECR_MSG_INITIALIZATION_REQUEST                  = 0x21,
    ECR_MSG_INITIALIZATION_RESPONSE                 = 0x22,
    ECR_MSG_RECEIPT_REQUEST                         = 0x23,
    ECR_MSG_RECEIPT_RESPONSE                        = 0x24,
    ECR_MSG_REPORT_REQUEST                          = 0x25,
    ECR_MSG_REPORT_RESPONSE                         = 0x26,

    ECR_MSG_TRX_DATA_CHANGE_REQUEST                 = 0x27,
    ECR_MSG_TRX_DATA_CHANGE_RESPONSE                = 0x28,
    ECR_MSG_CONFIRMATION_TIME_EXTENSION_REQUEST     = 0x29,
    ECR_MSG_CONFIRMATION_TIME_EXTENSION_RESPONSE    = 0x30,

    ECR_MSG_LOCK_EFT_OPERATIONS_REQUEST             = 0x31,
    ECR_MSG_LOCK_EFT_OPERATIONS_RESPONSE            = 0x32,
    ECR_MSG_UNLOCK_EFT_OPERATIONS_REQUEST           = 0x33,
    ECR_MSG_UNLOCK_EFT_OPERATIONS_RESPONSE          = 0x34,

    ECR_MSG_SET_TERMINAL_LANGUAGE_REQUEST           = 0x35,
    ECR_MSG_SET_TERMINAL_LANGUAGE_RESPONSE          = 0x36,

    ECR_MSG_DIALOG_REQUEST                          = 0x41,
    ECR_MSG_DIALOG_RESPONSE                         = 0x42,
    ECR_MSG_CANCEL_UI_REQUEST                       = 0x43,

    ECR_MSG_DISPLAY_NOTIFICATION                    = 0x51,
    ECR_MSG_RFID_STATUS_NOTIFICATION                = 0x53,

    ECR_MSG_LOYALTY_PROMOTION_NOTIFICATION          = 0x61,
    ECR_MSG_LOYALTY_ADVICE_NOTIFICATION             = 0x63,

    ECR_MSG_CLEAR_BASKET_REQUEST                    = 0x71,
    ECR_MSG_CLEAR_BASKET_RESPONSE                   = 0x72,
    ECR_MSG_ADD_TO_BASKET_REQUEST                   = 0x73,
    ECR_MSG_ADD_TO_BASKET_RESPONSE                  = 0x74,

    ECR_MSG_PRINT_RECEIPT_REQUEST                   = 0x81,
    ECR_MSG_PRINT_RECEIPT_RESPONSE                  = 0x82,

    ECR_MSG_DEVICE_COMMAND_REQUEST                  = 0x95,
    ECR_MSG_DEVICE_COMMAND_RESPONSE                 = 0x96,
    ECR_MSG_HEARTBEAT_REQUEST                       = 0x97,
    ECR_MSG_HEARTBEAT_RESPONSE                      = 0x98,
    ECR_MSG_ERROR_NOTIFICATION                      = 0x99
} ECRMessageType;

enum TrmStatus {
    ACTIVATED       = 0x00000001,
    BUSY            = 0x00000004
};

#define ESCAPE      0x10
#define START_FRAME 0x00
#define END_FRAME   0xFF
#define FRAME_ACK   0x11
#define FRAME_NAK   0x12

typedef enum FrameType_ {
    INFO_FRAME_ECR_TRM = 0x11,
    INFO_FRAME_TRM_ECR = 0x91
} FrameType;

typedef enum SerialReceiveState_ {
    SERIAL_RECEIVE_IDLE,
    SERIAL_RECEIVE_IDLE_ESCAPE,
    SERIAL_RECEIVE_SEQ_NO,
    SERIAL_RECEIVE_SEQ_NO_ESCAPE,
    SERIAL_RECEIVE_TYPE,
    SERIAL_RECEIVE_INFO_FRAME,
    SERIAL_RECEIVE_INFO_FRAME_ESCAPE
} SerialReceiveState;


typedef vector<unsigned char> ByteVector;

enum State {
    CONNECT,
    GET_STATUS,
    ACTIVATE,
    PAY,
    CONFIRM,
    RECEIPT
}                   state = CONNECT;
unsigned int        trmStatus;
unsigned int        bytesReceived;
char                receiveBuffer[MAX_LENGTH_ECR_FRAME];
int                 selectTimeout;
int                 serialPort = -1;
queue<ByteVector>   serialSendQueue;
int                 serialSendSeqNo;
int                 serialSendTries;
int                 serialSendFrameWireMilliseconds;
int                 serialTicksSinceLastSentFrame;
SerialReceiveState  serialReceiveState = SERIAL_RECEIVE_IDLE;
ByteVector          serialReceiveFrame;
ByteVector          lastSerialReceiveFrame;


#define MIN(a, b) ((b) < (a) ? (b) : (a))
#define MAX(a, b) ((b) > (a) ? (b) : (a))

void        changeState(State newState);
void        checkSerialSendQueue();
void        sendNextSerialFrame();
void        dequeueSerialSendFrame();
void        processSerialData(int length, const unsigned char *data);
void        changeSerialReceiveState(SerialReceiveState newState);
void        processTrmData(size_t length, void *data);
void        processTrmMessage();
void        sendMessage(const char *json);
int         openSerialPort(const char *path);
int         readSerialPort(void *data, int length);
int         writeSerialPort(const void *data, int length);
void        serialSendAck() { writeSerialPort("\x10\x11", 2); };
void        serialSendNak() { writeSerialPort("\x10\x12", 2); };
void        closeSerialPort();
void        dumpData(const char *title, const void* data, size_t length, int width);
int         hexDump(FILE* out, const void* data, size_t length, int width);
const char  *timeStamp();


int main()
{
#ifdef WINDOWS
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
    _set_fmode(O_BINARY);
#else
    signal(SIGPIPE, SIG_IGN);
#endif

    if (-1 == (serialPort = openSerialPort(SERIAL_DEVICE_PATH))) {
        perror("Cannot open serial port");
        return 1;
    }

    changeState(CONNECT);

    for(;;) {
        fd_set          fds;
        int             max = 0;
        struct timeval  timeout;

        selectTimeout = serialSendQueue.empty() ?
            1000 : (SERIAL_TIMEOUT + serialSendFrameWireMilliseconds);

        serialSendFrameWireMilliseconds = 0;

        timeout.tv_sec = selectTimeout / 1000;
        timeout.tv_usec = (selectTimeout % 1000) * 1000;

        FD_ZERO(&fds);

        if (-1 != serialPort) {
            FD_SET(serialPort, &fds);
            max = MAX(max, serialPort);
        }

        switch (select(max + 1, &fds, 0, 0, &timeout)) {
        case -1:
            perror("Cannot select");
            exit(-1);
            break;
        case 0:
            checkSerialSendQueue();
            break;
        default:
            if (FD_ISSET(serialPort, &fds)) {
                int             length;
                unsigned char   data[4096];

                if (0 < (length = readSerialPort(data, sizeof(data)))) {
                    processSerialData(length, data);
                }
                else {
                    perror("Reading serial port failed");
                    exit(-1);
                }
            }
        }
    }

    return 0;
}


void changeState(State newState)
{
    switch (newState) {
    case CONNECT:
        sendMessage("{\"ConnectRequest\":{\"TrmLng\":\"de\",\"PrinterWidth\":30}}");
        break;
    case GET_STATUS:
        sendMessage("{\"StatusRequest\":{}}");
        break;
    case ACTIVATE:
        sendMessage("{\"ActivationRequest\":{}}");
        break;
    case PAY:
        sendMessage("{\"TransactionRequest\":{\"TrxFunction\":32768,\"TrxCurrC\":756,\"AmtAuth\":175}}");
        break;
    case CONFIRM:
        sendMessage("{\"TransactionConfirmationRequest\":{\"Confirm\":1,\"AmtAuth\":175}}");
        break;
    case RECEIPT:
        sendMessage("{\"ReceiptRequest\":{\"ReceiptType\":1}}");
        break;
    }

    state = newState;
}

void checkSerialSendQueue()
{
    if (!serialSendQueue.empty()) {
        if (++serialTicksSinceLastSentFrame > (SERIAL_TIMEOUT / selectTimeout))
            sendNextSerialFrame();
    }
}

void sendNextSerialFrame()
{
    if (!serialSendQueue.empty()) {
        ByteVector &frame = serialSendQueue.front();

        if (++serialSendTries > MAX_TRIES_SEND_SERIAL_FRAME) {
            fprintf(stderr, "No ACK for frame (type '%02X', seq '%02X')\n",
                frame[2] == 0x10 ? frame[4] : frame[3], frame[2] == 0x10 ? frame[3] : frame[2]);

            dequeueSerialSendFrame();
        }
        else {
            writeSerialPort(&frame[0], frame.size());
            serialSendFrameWireMilliseconds = (frame.size() * 10 * 1000) / BAUD_RATE;
            serialTicksSinceLastSentFrame = 0;
        }
    }
}

void dequeueSerialSendFrame()
{
    if (!serialSendQueue.empty())
        serialSendQueue.pop();

    serialSendTries = 0;
}

void processSerialData(int length, const unsigned char *data)
{
    dumpData("<< Serial data: <<", data, length, 32);

    for (int i = 0; i < length; i++) {
        unsigned char byte = data[i];

        switch (serialReceiveState) {
        case SERIAL_RECEIVE_IDLE:
            switch (byte) {
            case ESCAPE:
                changeSerialReceiveState(SERIAL_RECEIVE_IDLE_ESCAPE);
                break;
            default:
                fprintf(stderr, "Undecodable data '%02X'\n");
                break;
            }
            break;
        case SERIAL_RECEIVE_IDLE_ESCAPE:
            switch (byte) {
            case START_FRAME:
                changeSerialReceiveState(SERIAL_RECEIVE_SEQ_NO);
                break;
            case FRAME_ACK:
                dequeueSerialSendFrame();
                sendNextSerialFrame();
                changeSerialReceiveState(SERIAL_RECEIVE_IDLE);
                break;
            case FRAME_NAK:
                if (serialSendTries > MAX_TRIES_SEND_SERIAL_FRAME) {
                    fprintf(stderr, "NAK after third try\n");
                    dequeueSerialSendFrame();
                }
                changeSerialReceiveState(SERIAL_RECEIVE_IDLE);
                break;
            default:
                changeSerialReceiveState(SERIAL_RECEIVE_IDLE);
                break;
            }
            break;
        case SERIAL_RECEIVE_SEQ_NO:
            switch (byte) {
            case ESCAPE:
                changeSerialReceiveState(SERIAL_RECEIVE_SEQ_NO_ESCAPE);
                break;
            default:
                serialReceiveFrame.push_back(byte);
                changeSerialReceiveState(SERIAL_RECEIVE_TYPE);
            }
            break;
        case SERIAL_RECEIVE_SEQ_NO_ESCAPE:
            switch (byte) {
            case ESCAPE:
                serialReceiveFrame.push_back(byte);
                changeSerialReceiveState(SERIAL_RECEIVE_TYPE);
                break;
            default:
                fprintf(stderr, "Ignoring unsupported escape sequence '%02X'\n", byte);
                changeSerialReceiveState(SERIAL_RECEIVE_SEQ_NO);
            }
            break;
        case SERIAL_RECEIVE_TYPE:
            switch (byte) {
            case INFO_FRAME_TRM_ECR:
                serialReceiveFrame.push_back(byte);
                changeSerialReceiveState(SERIAL_RECEIVE_INFO_FRAME);
                break;
            default:
                fprintf(stderr, "Unsupported frame type '%02X'\n", byte);
                serialSendNak();
                changeSerialReceiveState(SERIAL_RECEIVE_IDLE);
            }
            break;
        case SERIAL_RECEIVE_INFO_FRAME:
            switch (byte) {
            case ESCAPE:
                changeSerialReceiveState(SERIAL_RECEIVE_INFO_FRAME_ESCAPE);
                break;
            default:
                serialReceiveFrame.push_back(byte);
            }
            break;
        case SERIAL_RECEIVE_INFO_FRAME_ESCAPE:
            switch (byte) {
            case ESCAPE:
                serialReceiveFrame.push_back(byte);
                changeSerialReceiveState(SERIAL_RECEIVE_INFO_FRAME);
                break;
            case END_FRAME: {
                    unsigned short crc = 0;

                    for (size_t j = 0; j < serialReceiveFrame.size() - 2; j++) {
                        crc = (unsigned char)(crc >> 8) | (crc << 8);
                        crc ^= serialReceiveFrame[j];
                        crc ^= (unsigned char)(crc & 0xff) >> 4;
                        crc ^= (crc << 8) << 4;
                        crc ^= ((crc & 0xff) << 4) << 1;
                    }

                    if (((crc >> 8) == serialReceiveFrame[serialReceiveFrame.size() - 2])
                        && ((crc & 0xFF) == serialReceiveFrame[serialReceiveFrame.size() - 1]))
                    {
                        if (lastSerialReceiveFrame.empty() || (serialReceiveFrame[0] != lastSerialReceiveFrame[0])) {
                            serialSendAck();
                            lastSerialReceiveFrame = serialReceiveFrame;
                            processTrmData(serialReceiveFrame.size() - 4, &serialReceiveFrame[2]);
                        }
                        else if (serialReceiveFrame == lastSerialReceiveFrame) {
                            serialSendAck();

                            fprintf(stderr, "Repeated frame (type '%02X', seq '%02X')\n",
                                serialReceiveFrame[1], serialReceiveFrame[0]);
                        }
                        else {
                            fprintf(stderr, "Different frame, same Seq No (type '%02X', seq '%02X')\n",
                                serialReceiveFrame[1], serialReceiveFrame[0]);

                            serialSendNak();
                        }
                    }
                    else {
                        fprintf(stderr, "Wrong CRC %04X, expected %04X (frame type '%02X', seq '%02X')\n",
                            (serialReceiveFrame[serialReceiveFrame.size() - 2] << 8)
                                + serialReceiveFrame[serialReceiveFrame.size() - 1],
                            (unsigned int)crc, serialReceiveFrame[1], serialReceiveFrame[0]);

                        serialSendNak();
                    }

                    changeSerialReceiveState(SERIAL_RECEIVE_IDLE);
                }
                break;
            case FRAME_ACK: // just in case of an ACK sent inside an information frame
                dequeueSerialSendFrame();
                sendNextSerialFrame();
                break;
            case START_FRAME:
                fprintf(stderr, "New frame, discarding incomplete frame\n");
                serialReceiveFrame.clear();
                changeSerialReceiveState(SERIAL_RECEIVE_SEQ_NO);
                break;
            default:
                fprintf(stderr, "Ignoring unsupported escape sequence '%02X'\n", byte);
                changeSerialReceiveState(SERIAL_RECEIVE_INFO_FRAME);
            }
            break;
        }
    }
}

void changeSerialReceiveState(SerialReceiveState newState)
{
    switch (newState) {
    case SERIAL_RECEIVE_IDLE:
        serialReceiveFrame.clear();
        break;
    case SERIAL_RECEIVE_IDLE_ESCAPE:
        break;
    case SERIAL_RECEIVE_SEQ_NO:
        break;
    case SERIAL_RECEIVE_SEQ_NO_ESCAPE:
        break;
    case SERIAL_RECEIVE_TYPE:
        break;
    case SERIAL_RECEIVE_INFO_FRAME:
        break;
    case SERIAL_RECEIVE_INFO_FRAME_ESCAPE:
        break;
    }

    serialReceiveState = newState;
}

void processTrmData(size_t length, void *data)
{
    unsigned char *p = (unsigned char*)data;

    dumpData("<< Trm data: <<", data, length, 32);

    while (length--) {
        receiveBuffer[bytesReceived++] = *p++;

        if ('\n' == receiveBuffer[bytesReceived - 1]) {
            receiveBuffer[bytesReceived] = '\0';
            processTrmMessage();
            bytesReceived = 0;
        }
    }
}

void processTrmMessage()
{
    char message[64];
    char *p;
    
    // Note: Use a decent JSON parser like e.g. rapidjson in real world code!
    if (!strncmp(receiveBuffer, "{\"", 2)
        && (0 != (p = strstr(receiveBuffer, "\":")))) {
        memcpy(message, &receiveBuffer[2], p - receiveBuffer - 2);
        message[p - receiveBuffer - 2] = 0;

        if (!strcmp("HeartbeatRequest", message)) {
            sendMessage("{\"HeartbeatResponse\":{}}");
        }
        else if (!strcmp("StatusResponse", message)) {
            if (strstr(receiveBuffer, "TrmStatus"))
                sscanf(strstr(receiveBuffer, "TrmStatus"), "TrmStatus\":%d", &trmStatus);
        }

        switch (state) {
        case CONNECT:
            if (!strcmp("ConnectResponse", message))
                changeState(GET_STATUS);

            break;
        case GET_STATUS:
            if (0 == (BUSY & trmStatus))
                changeState(ACTIVATE);

            break;
        case ACTIVATE:
            if ((ACTIVATED & trmStatus) && (0 == (BUSY & trmStatus)))
                changeState(PAY);

            break;
        case PAY:
            if (!strcmp("TransactionResponse", message)) {
                if (strstr(receiveBuffer, "TrxResult")) {
                    unsigned int trxResult;

                    if (1 == sscanf(strstr(receiveBuffer, "TrxResult"), "TrxResult\":%d", &trxResult)) {
                        if (0 == trxResult) {
                            changeState(CONFIRM);
                        }
                        else {
                            fprintf(stderr, "Transaction declined\n");
                            exit(-1);
                        }
                    }
                    else {
                        fprintf(stderr, "Invalid TrxResult\n");
                        exit(-1);
                    }
                }
                else {
                    fprintf(stderr, "Missing TrxResult\n");
                    exit(-1);
                }
            }
            break;
        case CONFIRM:
            if (!strcmp("TransactionConfirmationResponse", message)) {
                changeState(RECEIPT);
            }
            break;
        case RECEIPT:
            fprintf(stderr, "All ok\n");
            getc(stdin);
            exit(0);
            break;
        }
    }
    else {
        fprintf(stderr, "Unable to parse terminal message '%s'\n", receiveBuffer);
    }
}

void sendMessage(const char *json)
{
    static unsigned int sequenceNumber;

    ByteVector      unescaped(json, json + strlen(json));
    ByteVector      sendFrame;
    unsigned short  crc = 0;

    dumpData(">> ECR data >>", json, strlen(json), 32);

    if ('\n' != unescaped.at(unescaped.size() - 1))
        unescaped.push_back('\n');

    unescaped.insert(unescaped.begin(), ++serialSendSeqNo);
    unescaped.insert(unescaped.begin() + 1, INFO_FRAME_ECR_TRM);

    sendFrame.push_back(ESCAPE);
    sendFrame.push_back(START_FRAME);

    for (size_t i = 0; i < unescaped.size(); i++) {
        if (unescaped[i] == 0x10)
            sendFrame.push_back(0x10);

        sendFrame.push_back(unescaped[i]);

        crc = (unsigned char)(crc >> 8) | (crc << 8);
        crc ^= unescaped[i];
        crc ^= (unsigned char)(crc & 0xff) >> 4;
        crc ^= (crc << 8) << 4;
        crc ^= ((crc & 0xff) << 4) << 1;
    }

    if ((crc >> 8) == ESCAPE)
        sendFrame.push_back(ESCAPE);

    sendFrame.push_back((char)(crc >> 8));

    if ((crc & 0xFF) == ESCAPE)
        sendFrame.push_back(ESCAPE);

    sendFrame.push_back((char)(crc & 0xFF));

    sendFrame.push_back(ESCAPE);
    sendFrame.push_back(END_FRAME);

    serialSendQueue.push(sendFrame);

    if (serialSendQueue.size() == 1)
        sendNextSerialFrame();
}

#ifdef WINDOWS
USHORT  port;
int     sock;
HANDLE  thread;
HANDLE  serverSocketReady;
HANDLE  serial = INVALID_HANDLE_VALUE;

static DWORD __stdcall serialThread(LPVOID)
{
	int server = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);

	if (server != INVALID_SOCKET) {
		struct sockaddr_in	serverAddr;
		unsigned int		yes = 1;

		serverAddr.sin_family		= AF_INET;
		serverAddr.sin_port			= htons(SERIAL_SERVER_PORT);
		serverAddr.sin_addr.s_addr	= inet_addr("127.0.0.1");

		setsockopt(server, SOL_SOCKET, SO_REUSEADDR, (const char*)&yes, sizeof(yes));

		if (bind(server, (struct sockaddr*)&serverAddr, sizeof(serverAddr)) != SOCKET_ERROR) {
			if (listen(server, 1) != SOCKET_ERROR) {
				struct sockaddr	clientAddr;
				int				clientAddrLen = sizeof(clientAddr);
				int				client;

				SetEvent(serverSocketReady);

				if (INVALID_SOCKET != (client = accept(server, &clientAddr, &clientAddrLen))) {
					char	data[256];
					DWORD	bytesRead;
                    DCB     dcb;

                    memset(&dcb, 0, sizeof(dcb));
                    dcb.DCBlength = sizeof(dcb);

                    while (GetCommState(serial, &dcb) && ReadFile(serial, data, 256, &bytesRead, 0)) {
						if (bytesRead)
					        send(client, data, bytesRead, 0);

                        Sleep(1);
					}

					closesocket(client);
				}
			}
		}

		closesocket(server);
	}

	return 0;
}
#endif // #ifdef WINDOWS

int openSerialPort(const char *serialDevicePath)
{
#ifdef WINDOWS
	if (INVALID_HANDLE_VALUE != serial) {
		errno = EACCES;
		return -1;
	}

	if (INVALID_HANDLE_VALUE != (serial = CreateFileA(serialDevicePath,
        GENERIC_READ | GENERIC_WRITE, 0, 0, OPEN_EXISTING, 0, 0))) {
        DCB				dcb;
        COMMTIMEOUTS	timeouts;

        memset(&dcb, 0, sizeof(dcb));
        dcb.DCBlength = sizeof(dcb);
        dcb.BaudRate = BAUD_RATE;
        dcb.ByteSize = 8;
        dcb.fBinary = 1;

        memset(&timeouts, 0, sizeof(timeouts));
        timeouts.ReadIntervalTimeout		= MAXDWORD;
        timeouts.ReadTotalTimeoutMultiplier	= MAXDWORD;
        timeouts.ReadTotalTimeoutConstant	= 1;

        if (SetCommState(serial, &dcb) && SetCommTimeouts(serial, &timeouts)) {
	        FlushFileBuffers(serial);
	        PurgeComm(serial, PURGE_RXCLEAR);

            if (INVALID_SOCKET != (sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP))) {
                if (0 != (serverSocketReady = CreateEventA(0, FALSE, FALSE, 0))) {
                    DWORD tid;
                    if ((thread = CreateThread(0, 0, serialThread, 0, 0, &tid)) != 0) {
                        if (WaitForSingleObject(serverSocketReady, 100) == WAIT_OBJECT_0) {
                            struct sockaddr_in addr;

                            addr.sin_family			= AF_INET;
                            addr.sin_port			= htons(SERIAL_SERVER_PORT);
                            addr.sin_addr.s_addr	= inet_addr("127.0.0.1");

                            if (connect(sock, (struct sockaddr*)&addr, sizeof(addr)) != SOCKET_ERROR)
                                return sock;
                        }

                        if (WaitForSingleObject(thread, 10))
                            TerminateThread(thread, -1);

                        CloseHandle(thread);
                    }

                    CloseHandle(serverSocketReady);
                }

                closesocket(sock);
            }
        }
    }

    CloseHandle(serial);
    serial = INVALID_HANDLE_VALUE;
    return -1;
#else // #ifdef WINDOWS
    int     fd;
    struct  termios tio;

    if (-1 == (fd = open(serialDevicePath, O_RDWR)))
        return -1;

    memset(&tio, 0, sizeof(tio));
    tio.c_cflag = B115200;
    tio.c_cflag |= CS8;
    tio.c_cflag |= CLOCAL | CREAD;
    tio.c_iflag = IGNPAR;
    tio.c_cc[VMIN]	= 1;
    tio.c_cc[VTIME]	= 5;

    if (tcsetattr(fd, TCSANOW, &tio) != 0) {
        close(fd);
        return -1;
    }

    return fd;
#endif // #else // #ifdef WINDOWS
}

int readSerialPort(void *data, int length)
{
#ifdef WINDOWS
    return recv(serialPort, (char*)data, length, 0);
#else
    return read(serialPort, data, length);
#endif
}

int writeSerialPort(const void *data, int length)
{
    int result;

    dumpData(">> Serial data >>", data, length, 32);
#ifdef WINDOWS
	if (INVALID_HANDLE_VALUE == serial) {
		errno = EBADF;
		return -1;
	}

    if (length > 0) {
        DWORD bytesReceived;

	    if (!WriteFile(serial, data, length, &bytesReceived, 0)) {
		    errno = GetLastError();
		    return -1;
	    }

        result = static_cast<int>(bytesReceived);
        FlushFileBuffers(serial);
    }
#else
    result = write(serialPort, data, length);
#endif

    return result;
}

void closeSerialPort()
{
    if (serialPort != -1) {
#ifdef WINDOWS
        if (INVALID_HANDLE_VALUE == serial) {
            errno = EBADF;
            return;
        }

        CloseHandle(serial);

        if (WAIT_OBJECT_0 != WaitForSingleObject(thread, 1000))
            TerminateThread(thread, -1);

        closesocket(sock);
        CloseHandle(thread);
        CloseHandle(serverSocketReady);

        serial = INVALID_HANDLE_VALUE;
#else
        close(serialPort);
#endif
        serialPort = -1;
    }

    serialReceiveFrame.clear();
    lastSerialReceiveFrame.clear();
}

void dumpData(const char *title, const void* data, size_t length, int width)
{
    if (title)
        fprintf(stderr, "%s - %s\n", timeStamp(), title);

    hexDump(stderr, data, length, width);
}

int hexDump(FILE* out, const void* data, size_t length, int width)
{
#define MAX_WIDTH_HEX_DUMP 32
	int						ret = 0;
	size_t					i;
	const unsigned char*	ucData = (const unsigned char*)data;

	if(width < 1)
		width = 1;

	if(width > MAX_WIDTH_HEX_DUMP)
		width = MAX_WIDTH_HEX_DUMP;

	for(i = 0; i < length; i += width)
	{
		/*                ->   <-                 ->  <-                      -> <-      ->      <-
		                    01 AB           . 01 AB - 01 AB ..               AB  xy..      xyzw..        \0 */
		char line[MAX_WIDTH_HEX_DUMP * 3 + ((MAX_WIDTH_HEX_DUMP - 1) / 8) * 2 + 1 + MAX_WIDTH_HEX_DUMP + 1];
		int  j;

		for(j = 0; j < (int)sizeof(line); j++)
			line[j] = ' ';

		for(j = 0; (j < width) && (i + j < length); j++, ret += 4)
		{
			unsigned char byte = ucData[i + j];
			unsigned char nibble1 = byte >> 4;
			unsigned char nibble2 = byte & 0x0F;
			char          *p = &line[j * 3 + (j / 8) * 2];

			*p++ = nibble1 >= 0x0A ? nibble1 - 0x0A + 'A' : nibble1 + '0';
			*p++ = nibble2 >= 0x0A ? nibble2 - 0x0A + 'A' : nibble2 + '0';
			*p++ = ' ';

			if((j % 8 == 7) && (j < width - 1))
			{
				*p++ = '-';
				*p++ = ' ';
				ret += 2;
			}

			line[width * 3 + ((width - 1) / 8) * 2 + 1 + j] = (0x20 <= byte) && (byte <= 0x7E) ? byte : '.';
		}

		line[width * 3 + ((width - 1) / 8) * 2 + 1 + width] = 0;
		fprintf(out, "%s\n", line);
		ret += 2;
	}

	return ret;
}

const char *timeStamp()
{
    static char str[64];
    time_t      secondsSinceEpoch;
    int         milliSeconds;

#ifdef WIN32
    secondsSinceEpoch = time(0);
    milliSeconds = GetTickCount();
#else
    struct timeval tv = { 0, 0 };
    struct timezone tz;
    gettimeofday(&tv, &tz);
    secondsSinceEpoch = tv.tv_sec;
    milliSeconds = tv.tv_usec / 1000;
#endif
    const tm *local = localtime(&secondsSinceEpoch);
    sprintf(&str[strftime(str, sizeof(str), "%Y-%m-%d %H:%M:%S", local)], ".%03d", milliSeconds);
    return str;
}
